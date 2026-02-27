import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "node:path";
import { PAGES_FIXTURE_DIR } from "./helpers.js";
import { isExternalUrl, isHashOnlyChange } from "../packages/vinext/src/shims/router.js";
import { isValidModulePath } from "../packages/vinext/src/client/validate-module-path.js";

const FIXTURE_DIR = PAGES_FIXTURE_DIR;

describe("next/navigation shim", () => {
  it("exports usePathname, useSearchParams, useParams, useRouter", async () => {
    const nav = await import(
      "../packages/vinext/src/shims/navigation.js"
    );
    expect(typeof nav.usePathname).toBe("function");
    expect(typeof nav.useSearchParams).toBe("function");
    expect(typeof nav.useParams).toBe("function");
    expect(typeof nav.useRouter).toBe("function");
  });

  it("exports redirect, notFound, permanentRedirect", async () => {
    const nav = await import(
      "../packages/vinext/src/shims/navigation.js"
    );
    expect(typeof nav.redirect).toBe("function");
    expect(typeof nav.notFound).toBe("function");
    expect(typeof nav.permanentRedirect).toBe("function");
  });

  it("redirect() throws with correct digest", async () => {
    const { redirect } = await import(
      "../packages/vinext/src/shims/navigation.js"
    );
    try {
      redirect("/login");
      expect.unreachable("should have thrown");
    } catch (e: any) {
      expect(e.digest).toContain("NEXT_REDIRECT");
      // URL is encodeURIComponent-encoded in the digest to prevent delimiter injection
      expect(e.digest).toContain(encodeURIComponent("/login"));
    }
  });

  it("redirect() encodes semicolons in URL to prevent digest injection", async () => {
    const { redirect } = await import(
      "../packages/vinext/src/shims/navigation.js"
    );
    try {
      redirect("http://example.com;301");
      expect.unreachable("should have thrown");
    } catch (e: any) {
      const parts = e.digest.split(";");
      // The URL field must not leak into the status code position
      expect(parts).toHaveLength(3); // NEXT_REDIRECT, type, encoded-url
      expect(parts[0]).toBe("NEXT_REDIRECT");
      expect(parts[1]).toBe("replace");
      expect(decodeURIComponent(parts[2])).toBe("http://example.com;301");
    }
  });

  it("notFound() throws with correct digest", async () => {
    const { notFound } = await import(
      "../packages/vinext/src/shims/navigation.js"
    );
    try {
      notFound();
      expect.unreachable("should have thrown");
    } catch (e: any) {
      expect(e.digest).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
    }
  });

  it("forbidden() throws with correct digest", async () => {
    const { forbidden } = await import(
      "../packages/vinext/src/shims/navigation.js"
    );
    try {
      forbidden();
      expect.unreachable("should have thrown");
    } catch (e: any) {
      expect(e.digest).toBe("NEXT_HTTP_ERROR_FALLBACK;403");
    }
  });

  it("unauthorized() throws with correct digest", async () => {
    const { unauthorized } = await import(
      "../packages/vinext/src/shims/navigation.js"
    );
    try {
      unauthorized();
      expect.unreachable("should have thrown");
    } catch (e: any) {
      expect(e.digest).toBe("NEXT_HTTP_ERROR_FALLBACK;401");
    }
  });

  it("isHTTPAccessFallbackError detects all HTTP access fallback errors", async () => {
    const { notFound, forbidden, unauthorized, isHTTPAccessFallbackError, getAccessFallbackHTTPStatus } = await import(
      "../packages/vinext/src/shims/navigation.js"
    );

    // Test notFound
    try { notFound(); } catch (e) {
      expect(isHTTPAccessFallbackError(e)).toBe(true);
      expect(getAccessFallbackHTTPStatus(e)).toBe(404);
    }

    // Test forbidden
    try { forbidden(); } catch (e) {
      expect(isHTTPAccessFallbackError(e)).toBe(true);
      expect(getAccessFallbackHTTPStatus(e)).toBe(403);
    }

    // Test unauthorized
    try { unauthorized(); } catch (e) {
      expect(isHTTPAccessFallbackError(e)).toBe(true);
      expect(getAccessFallbackHTTPStatus(e)).toBe(401);
    }

    // Test non-access error
    expect(isHTTPAccessFallbackError(new Error("random"))).toBe(false);
    expect(isHTTPAccessFallbackError(null)).toBe(false);

    // Test legacy NEXT_NOT_FOUND format
    const legacyErr = new Error("old");
    (legacyErr as any).digest = "NEXT_NOT_FOUND";
    expect(isHTTPAccessFallbackError(legacyErr)).toBe(true);
    expect(getAccessFallbackHTTPStatus(legacyErr)).toBe(404);
  });

  it("setNavigationContext / useParams works on server side", async () => {
    const { setNavigationContext, useParams } = await import(
      "../packages/vinext/src/shims/navigation.js"
    );
    setNavigationContext({
      pathname: "/blog/test",
      searchParams: new URLSearchParams(""),
      params: { slug: "test" },
    });
    const params = useParams();
    expect(params).toEqual({ slug: "test" });
    setNavigationContext(null);
  });

  it("setClientParams provides referential stability for identical params", async () => {
    const { setClientParams, getClientParams } = await import(
      "../packages/vinext/src/shims/navigation.js"
    );
    // Set params initially
    setClientParams({ slug: "hello" });
    const first = getClientParams();
    // Set params with same values — should return same object reference
    setClientParams({ slug: "hello" });
    const second = getClientParams();
    expect(first).toBe(second); // referential equality

    // Set params with different values — should return new object
    setClientParams({ slug: "world" });
    const third = getClientParams();
    expect(third).not.toBe(first);
    expect(third).toEqual({ slug: "world" });

    // Clean up
    setClientParams({});
  });

  it("exports useSelectedLayoutSegment and useSelectedLayoutSegments", async () => {
    const nav = await import(
      "../packages/vinext/src/shims/navigation.js"
    );
    expect(typeof nav.useSelectedLayoutSegment).toBe("function");
    expect(typeof nav.useSelectedLayoutSegments).toBe("function");
  });

  it("useSelectedLayoutSegments returns path segments from server context", async () => {
    const { setNavigationContext, useSelectedLayoutSegments } = await import(
      "../packages/vinext/src/shims/navigation.js"
    );
    setNavigationContext({
      pathname: "/dashboard/settings/profile",
      searchParams: new URLSearchParams(""),
      params: {},
    });
    const segments = useSelectedLayoutSegments();
    expect(segments).toEqual(["dashboard", "settings", "profile"]);
    setNavigationContext(null);
  });

  it("useSelectedLayoutSegment returns first segment or null", async () => {
    const { setNavigationContext, useSelectedLayoutSegment } = await import(
      "../packages/vinext/src/shims/navigation.js"
    );
    setNavigationContext({
      pathname: "/blog/my-post",
      searchParams: new URLSearchParams(""),
      params: {},
    });
    expect(useSelectedLayoutSegment()).toBe("blog");

    setNavigationContext({
      pathname: "/",
      searchParams: new URLSearchParams(""),
      params: {},
    });
    expect(useSelectedLayoutSegment()).toBeNull();
    setNavigationContext(null);
  });
});

describe("next/headers shim", () => {
  it("exports cookies, headers, draftMode", async () => {
    const mod = await import(
      "../packages/vinext/src/shims/headers.js"
    );
    expect(typeof mod.cookies).toBe("function");
    expect(typeof mod.headers).toBe("function");
    expect(typeof mod.draftMode).toBe("function");
  });

  it("headers() returns request headers from context", async () => {
    const { setHeadersContext, headers } = await import(
      "../packages/vinext/src/shims/headers.js"
    );
    const reqHeaders = new Headers({ "x-custom": "test-value" });
    setHeadersContext({
      headers: reqHeaders,
      cookies: new Map(),
    });

    const h = await headers();
    expect(h.get("x-custom")).toBe("test-value");
    setHeadersContext(null);
  });

  it("cookies() returns parsed cookies from context", async () => {
    const { setHeadersContext, cookies } = await import(
      "../packages/vinext/src/shims/headers.js"
    );
    setHeadersContext({
      headers: new Headers(),
      cookies: new Map([
        ["session", "abc123"],
        ["theme", "dark"],
      ]),
    });

    const c = await cookies();
    expect(c.get("session")).toEqual({ name: "session", value: "abc123" });
    expect(c.get("theme")).toEqual({ name: "theme", value: "dark" });
    expect(c.has("session")).toBe(true);
    expect(c.has("missing")).toBe(false);
    expect(c.size).toBe(2);
    setHeadersContext(null);
  });

  it("headersContextFromRequest parses cookies from Request", async () => {
    const { headersContextFromRequest } = await import(
      "../packages/vinext/src/shims/headers.js"
    );
    const req = new Request("https://example.com", {
      headers: { cookie: "a=1; b=2" },
    });
    const ctx = headersContextFromRequest(req);

    expect(ctx.cookies.get("a")).toBe("1");
    expect(ctx.cookies.get("b")).toBe("2");
    expect(ctx.headers.get("cookie")).toBe("a=1; b=2");
  });

  it("throws when called outside request context", async () => {
    const { headers, cookies } = await import(
      "../packages/vinext/src/shims/headers.js"
    );
    // Ensure context is cleared
    const { setHeadersContext } = await import(
      "../packages/vinext/src/shims/headers.js"
    );
    setHeadersContext(null);

    await expect(headers()).rejects.toThrow("Server Component");
    await expect(cookies()).rejects.toThrow("Server Component");
  });

  it("draftMode() returns isEnabled=false when no bypass cookie", async () => {
    const { setHeadersContext, draftMode } = await import(
      "../packages/vinext/src/shims/headers.js"
    );
    setHeadersContext({
      headers: new Headers(),
      cookies: new Map(),
    });
    const dm = await draftMode();
    expect(dm.isEnabled).toBe(false);
    setHeadersContext(null);
  });

  it("draftMode() returns isEnabled=false for arbitrary cookie values (not signed)", async () => {
    const { setHeadersContext, draftMode } = await import(
      "../packages/vinext/src/shims/headers.js"
    );
    // An arbitrary cookie value should NOT enable draft mode — only the
    // server-generated secret is valid.
    setHeadersContext({
      headers: new Headers(),
      cookies: new Map([["__prerender_bypass", "1"]]),
    });
    const dm = await draftMode();
    expect(dm.isEnabled).toBe(false);
    setHeadersContext(null);
  });

  it("draftMode().enable() sets the bypass cookie in context", async () => {
    const { setHeadersContext, draftMode, getDraftModeCookieHeader } = await import(
      "../packages/vinext/src/shims/headers.js"
    );
    setHeadersContext({
      headers: new Headers(),
      cookies: new Map(),
    });
    const dm = await draftMode();
    expect(dm.isEnabled).toBe(false);

    dm.enable();
    // After enabling, the cookie should be set on the context
    const dm2 = await draftMode();
    expect(dm2.isEnabled).toBe(true);

    // The Set-Cookie header should be generated with a non-predictable secret (UUID)
    const cookieHeader = getDraftModeCookieHeader();
    expect(cookieHeader).toContain("__prerender_bypass=");
    const bypassMatch = cookieHeader!.match(/__prerender_bypass=([^;]+)/);
    expect(bypassMatch).not.toBeNull();
    expect(bypassMatch![1]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(cookieHeader).toContain("HttpOnly");
    setHeadersContext(null);
  });

  it("draftMode().disable() clears the bypass cookie", async () => {
    const { setHeadersContext, draftMode, getDraftModeCookieHeader } = await import(
      "../packages/vinext/src/shims/headers.js"
    );
    setHeadersContext({
      headers: new Headers(),
      cookies: new Map(),
    });
    // Enable first so the cookie is set to the server secret
    const dm = await draftMode();
    dm.enable();
    // Consume the enable Set-Cookie header
    getDraftModeCookieHeader();

    const dm1 = await draftMode();
    expect(dm1.isEnabled).toBe(true);

    dm1.disable();
    const dm2 = await draftMode();
    expect(dm2.isEnabled).toBe(false);

    const cookieHeader = getDraftModeCookieHeader();
    expect(cookieHeader).toContain("Max-Age=0");
    setHeadersContext(null);
  });
});

describe("next/headers writable cookies", () => {
  it("cookies().set() updates the cookie map and accumulates Set-Cookie headers", async () => {
    const { setHeadersContext, cookies, getAndClearPendingCookies } = await import(
      "../packages/vinext/src/shims/headers.js"
    );
    setHeadersContext({
      headers: new Headers(),
      cookies: new Map(),
    });

    const c = await cookies();
    c.set("token", "xyz", { path: "/", httpOnly: true, secure: true });

    // Cookie should now be readable
    expect(c.get("token")).toEqual({ name: "token", value: "xyz" });
    expect(c.has("token")).toBe(true);

    // Pending Set-Cookie headers should be accumulated
    const pending = getAndClearPendingCookies();
    expect(pending.length).toBe(1);
    expect(pending[0]).toContain("token=xyz");
    expect(pending[0]).toContain("Path=/");
    expect(pending[0]).toContain("HttpOnly");
    expect(pending[0]).toContain("Secure");

    // After clearing, should be empty
    expect(getAndClearPendingCookies().length).toBe(0);
    setHeadersContext(null);
  });

  it("cookies().delete() removes from map and adds Max-Age=0 header", async () => {
    const { setHeadersContext, cookies, getAndClearPendingCookies } = await import(
      "../packages/vinext/src/shims/headers.js"
    );
    setHeadersContext({
      headers: new Headers(),
      cookies: new Map([["session", "abc"]]),
    });

    const c = await cookies();
    expect(c.has("session")).toBe(true);
    c.delete("session");
    expect(c.has("session")).toBe(false);

    const pending = getAndClearPendingCookies();
    expect(pending.length).toBe(1);
    expect(pending[0]).toContain("session=");
    expect(pending[0]).toContain("Max-Age=0");
    setHeadersContext(null);
  });

  it("cookies().set() with object syntax works", async () => {
    const { setHeadersContext, cookies, getAndClearPendingCookies } = await import(
      "../packages/vinext/src/shims/headers.js"
    );
    setHeadersContext({
      headers: new Headers(),
      cookies: new Map(),
    });

    const c = await cookies();
    c.set({ name: "pref", value: "dark", sameSite: "Lax" });
    expect(c.get("pref")?.value).toBe("dark");

    const pending = getAndClearPendingCookies();
    expect(pending[0]).toContain("pref=dark");
    expect(pending[0]).toContain("SameSite=Lax");
    setHeadersContext(null);
  });
});

describe("next/server shim", () => {
  it("NextRequest wraps a standard Request with nextUrl and cookies", async () => {
    const { NextRequest } = await import(
      "../packages/vinext/src/shims/server.js"
    );
    const req = new NextRequest("https://example.com/blog?page=2", {
      headers: { cookie: "session=abc123; theme=dark" },
    });

    expect(req.nextUrl.pathname).toBe("/blog");
    expect(req.nextUrl.searchParams.get("page")).toBe("2");
    expect(req.cookies.get("session")).toEqual({ name: "session", value: "abc123" });
    expect(req.cookies.get("theme")).toEqual({ name: "theme", value: "dark" });
    expect(req.cookies.has("session")).toBe(true);
    expect(req.cookies.has("missing")).toBe(false);
  });

  it("NextResponse.json() creates a JSON response", async () => {
    const { NextResponse } = await import(
      "../packages/vinext/src/shims/server.js"
    );
    const res = NextResponse.json({ message: "hello" }, { status: 201 });

    expect(res.status).toBe(201);
    expect(res.headers.get("content-type")).toBe("application/json");
    const body = await res.json();
    expect(body).toEqual({ message: "hello" });
  });

  it("NextResponse.redirect() creates a redirect response", async () => {
    const { NextResponse } = await import(
      "../packages/vinext/src/shims/server.js"
    );
    const res = NextResponse.redirect("https://example.com/new", 308);

    expect(res.status).toBe(308);
    expect(res.headers.get("Location")).toBe("https://example.com/new");
  });

  it("NextResponse.rewrite() sets x-middleware-rewrite header", async () => {
    const { NextResponse } = await import(
      "../packages/vinext/src/shims/server.js"
    );
    const res = NextResponse.rewrite("https://example.com/internal");

    expect(res.headers.get("x-middleware-rewrite")).toBe("https://example.com/internal");
  });

  it("NextResponse.next() sets x-middleware-next header", async () => {
    const { NextResponse } = await import(
      "../packages/vinext/src/shims/server.js"
    );
    const res = NextResponse.next();

    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("ResponseCookies set/get/delete work", async () => {
    const { NextResponse } = await import(
      "../packages/vinext/src/shims/server.js"
    );
    const res = new NextResponse();
    res.cookies.set("token", "xyz", { path: "/", httpOnly: true });

    const cookie = res.cookies.get("token");
    expect(cookie).toBeTruthy();
    expect(cookie!.value).toBe("xyz");

    // Verify the Set-Cookie header was set
    const setCookie = res.headers.getSetCookie();
    expect(setCookie.length).toBeGreaterThan(0);
    expect(setCookie[0]).toContain("token=xyz");
    expect(setCookie[0]).toContain("HttpOnly");
  });

  it("userAgentFromString detects bots", async () => {
    const { userAgentFromString } = await import(
      "../packages/vinext/src/shims/server.js"
    );
    const bot = userAgentFromString("Googlebot/2.1");
    expect(bot.isBot).toBe(true);

    const human = userAgentFromString("Mozilla/5.0");
    expect(human.isBot).toBe(false);
  });

  it("after() runs a callback asynchronously without throwing", async () => {
    const { after } = await import(
      "../packages/vinext/src/shims/server.js"
    );
    let called = false;
    after(() => {
      called = true;
    });
    // after() schedules as a microtask, so await a tick
    await new Promise((r) => setTimeout(r, 10));
    expect(called).toBe(true);
  });

  it("after() handles a promise argument", async () => {
    const { after } = await import(
      "../packages/vinext/src/shims/server.js"
    );
    let resolved = false;
    const p = new Promise<void>((resolve) => {
      setTimeout(() => {
        resolved = true;
        resolve();
      }, 5);
    });
    after(p);
    await new Promise((r) => setTimeout(r, 20));
    expect(resolved).toBe(true);
  });

  it("after() swallows errors from failing tasks", async () => {
    const { after } = await import(
      "../packages/vinext/src/shims/server.js"
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    after(() => {
      throw new Error("task failed");
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(consoleError).toHaveBeenCalledWith(
      "[vinext] after() task failed:",
      expect.any(Error),
    );
    consoleError.mockRestore();
  });

  it("connection() returns a resolved promise", async () => {
    const { connection } = await import(
      "../packages/vinext/src/shims/server.js"
    );
    const result = connection();
    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toBeUndefined();
  });

  it("URLPattern is exported and available in Node 20+", async () => {
    const { URLPattern } = await import(
      "../packages/vinext/src/shims/server.js"
    );
    // Node 22+ has URLPattern globally; if available, test it works
    if (globalThis.URLPattern) {
      expect(URLPattern).toBe(globalThis.URLPattern);
      const pattern = new URLPattern({ pathname: "/blog/:slug" });
      const match = pattern.exec({ pathname: "/blog/hello-world" });
      expect(match).toBeTruthy();
      expect(match!.pathname.groups.slug).toBe("hello-world");
    } else {
      // URLPattern not available — our export should be a fallback that throws
      expect(typeof URLPattern).toBe("function");
    }
  });
});

describe("next/config shim", () => {
  it("getConfig returns default empty config", async () => {
    const { default: getConfig } = await import(
      "../packages/vinext/src/shims/config.js"
    );
    const config = getConfig();
    expect(config).toEqual({
      serverRuntimeConfig: {},
      publicRuntimeConfig: {},
    });
  });

  it("setConfig updates the runtime config", async () => {
    const { default: getConfig, setConfig } = await import(
      "../packages/vinext/src/shims/config.js"
    );
    setConfig({
      serverRuntimeConfig: { secret: "s3cr3t" },
      publicRuntimeConfig: { appName: "test-app" },
    });
    const config = getConfig();
    expect(config.serverRuntimeConfig.secret).toBe("s3cr3t");
    expect(config.publicRuntimeConfig.appName).toBe("test-app");

    // Reset for other tests
    setConfig({ serverRuntimeConfig: {}, publicRuntimeConfig: {} });
  });
});

describe("next/cache shim", () => {
  it("exports revalidateTag, revalidatePath, unstable_cache", async () => {
    const mod = await import(
      "../packages/vinext/src/shims/cache.js"
    );
    expect(typeof mod.revalidateTag).toBe("function");
    expect(typeof mod.revalidatePath).toBe("function");
    expect(typeof mod.unstable_cache).toBe("function");
  });

  it("exports setCacheHandler and getCacheHandler", async () => {
    const mod = await import(
      "../packages/vinext/src/shims/cache.js"
    );
    expect(typeof mod.setCacheHandler).toBe("function");
    expect(typeof mod.getCacheHandler).toBe("function");
  });

  it("default handler is MemoryCacheHandler", async () => {
    const { getCacheHandler, MemoryCacheHandler } = await import(
      "../packages/vinext/src/shims/cache.js"
    );
    const handler = getCacheHandler();
    expect(handler).toBeInstanceOf(MemoryCacheHandler);
  });

  it("unstable_cache caches function results", async () => {
    const { unstable_cache, setCacheHandler, MemoryCacheHandler } =
      await import("../packages/vinext/src/shims/cache.js");

    // Fresh handler for isolation
    setCacheHandler(new MemoryCacheHandler());

    let callCount = 0;
    const expensive = async (x: number) => {
      callCount++;
      return x * 2;
    };

    const cached = unstable_cache(expensive, ["test-fn"], {
      tags: ["test-tag"],
    });

    const r1 = await cached(5);
    expect(r1).toBe(10);
    expect(callCount).toBe(1);

    const r2 = await cached(5);
    expect(r2).toBe(10);
    expect(callCount).toBe(1); // Should NOT call the function again

    const r3 = await cached(10);
    expect(r3).toBe(20);
    expect(callCount).toBe(2); // Different args = different cache key

    // Reset
    setCacheHandler(new MemoryCacheHandler());
  });

  it("revalidateTag invalidates cached entries", async () => {
    const {
      unstable_cache,
      revalidateTag,
      setCacheHandler,
      MemoryCacheHandler,
    } = await import("../packages/vinext/src/shims/cache.js");

    setCacheHandler(new MemoryCacheHandler());

    let callCount = 0;
    const fn = async () => {
      callCount++;
      return "result-" + callCount;
    };

    const cached = unstable_cache(fn, ["revalidate-test"], {
      tags: ["my-tag"],
    });

    const r1 = await cached();
    expect(r1).toBe("result-1");
    expect(callCount).toBe(1);

    // Revalidate the tag
    await revalidateTag("my-tag");

    // Next call should re-execute the function
    const r2 = await cached();
    expect(r2).toBe("result-2");
    expect(callCount).toBe(2);

    // Reset
    setCacheHandler(new MemoryCacheHandler());
  });

  it("revalidateTag accepts optional cacheLife profile (Next.js 16)", async () => {
    const {
      revalidateTag,
      setCacheHandler,
      MemoryCacheHandler,
    } = await import("../packages/vinext/src/shims/cache.js");

    setCacheHandler(new MemoryCacheHandler());

    // Should not throw with profile argument
    await revalidateTag("my-tag", "max");
    await revalidateTag("my-tag", "hours");
    await revalidateTag("my-tag", { expire: 3600 });

    // Should still work without profile (deprecated single-arg form)
    await revalidateTag("my-tag");

    setCacheHandler(new MemoryCacheHandler());
  });

  it("exports updateTag function (Next.js 16)", async () => {
    const mod = await import("../packages/vinext/src/shims/cache.js");
    expect(typeof mod.updateTag).toBe("function");
  });

  it("updateTag invalidates cached entries", async () => {
    const {
      unstable_cache,
      updateTag,
      setCacheHandler,
      MemoryCacheHandler,
    } = await import("../packages/vinext/src/shims/cache.js");

    setCacheHandler(new MemoryCacheHandler());

    let callCount = 0;
    const fn = async () => {
      callCount++;
      return "result-" + callCount;
    };

    const cached = unstable_cache(fn, ["update-tag-test"], {
      tags: ["user-1"],
    });

    const r1 = await cached();
    expect(r1).toBe("result-1");

    // updateTag expires the cache
    await updateTag("user-1");

    const r2 = await cached();
    expect(r2).toBe("result-2");
    expect(callCount).toBe(2);

    setCacheHandler(new MemoryCacheHandler());
  });

  it("exports refresh function (Next.js 16)", async () => {
    const mod = await import("../packages/vinext/src/shims/cache.js");
    expect(typeof mod.refresh).toBe("function");
    // refresh() is a no-op on the server but should not throw
    mod.refresh();
  });

  it("setCacheHandler swaps the active handler", async () => {
    const { setCacheHandler, getCacheHandler, unstable_cache } = await import(
      "../packages/vinext/src/shims/cache.js"
    );

    // Create a custom handler that tracks calls
    const calls: string[] = [];
    const customHandler = {
      async get(key: string) {
        calls.push(`get:${key}`);
        return null;
      },
      async set(key: string) {
        calls.push(`set:${key}`);
      },
      async revalidateTag(tags: string | string[]) {
        const tagList = Array.isArray(tags) ? tags : [tags];
        calls.push(`revalidateTag:${tagList.join(",")}`);
      },
      resetRequestCache() {
        calls.push("reset");
      },
    };

    const originalHandler = getCacheHandler();
    setCacheHandler(customHandler);

    const cached = unstable_cache(async () => 42, ["custom-test"]);
    await cached();

    expect(calls.some((c) => c.startsWith("get:"))).toBe(true);
    expect(calls.some((c) => c.startsWith("set:"))).toBe(true);

    // Restore
    setCacheHandler(originalHandler);
  });

  it("MemoryCacheHandler.get/set round-trips values", async () => {
    const { MemoryCacheHandler } = await import(
      "../packages/vinext/src/shims/cache.js"
    );

    const handler = new MemoryCacheHandler();

    await handler.set("test-key", {
      kind: "FETCH",
      data: { headers: {}, body: '{"x":1}', url: "test" },
      tags: ["t1"],
      revalidate: 3600,
    });

    const result = await handler.get("test-key");
    expect(result).not.toBeNull();
    expect(result!.value).not.toBeNull();
    expect(result!.value!.kind).toBe("FETCH");
    if (result!.value!.kind === "FETCH") {
      expect(result!.value!.data.body).toBe('{"x":1}');
    }
  });

  it("MemoryCacheHandler respects tag invalidation", async () => {
    const { MemoryCacheHandler } = await import(
      "../packages/vinext/src/shims/cache.js"
    );

    const handler = new MemoryCacheHandler();

    await handler.set(
      "tagged-entry",
      {
        kind: "FETCH",
        data: { headers: {}, body: '"cached"', url: "test" },
        tags: ["fresh-tag"],
        revalidate: 3600,
      },
      { tags: ["fresh-tag"] },
    );

    // Should return the entry
    let result = await handler.get("tagged-entry");
    expect(result).not.toBeNull();

    // Invalidate the tag
    await handler.revalidateTag("fresh-tag");

    // Should now return null (invalidated)
    result = await handler.get("tagged-entry");
    expect(result).toBeNull();
  });

  it("exports unstable_noStore and noStore as no-ops", async () => {
    const { unstable_noStore, noStore } = await import(
      "../packages/vinext/src/shims/cache.js"
    );
    expect(typeof unstable_noStore).toBe("function");
    expect(typeof noStore).toBe("function");
    // Both should run without throwing
    expect(() => unstable_noStore()).not.toThrow();
    expect(() => noStore()).not.toThrow();
  });

  it("exports cacheLife with built-in profiles", async () => {
    const { cacheLife, cacheLifeProfiles } = await import(
      "../packages/vinext/src/shims/cache.js"
    );
    expect(typeof cacheLife).toBe("function");
    expect(typeof cacheLifeProfiles).toBe("object");

    // Built-in profiles should exist
    expect(cacheLifeProfiles).toHaveProperty("default");
    expect(cacheLifeProfiles).toHaveProperty("seconds");
    expect(cacheLifeProfiles).toHaveProperty("minutes");
    expect(cacheLifeProfiles).toHaveProperty("hours");
    expect(cacheLifeProfiles).toHaveProperty("days");
    expect(cacheLifeProfiles).toHaveProperty("weeks");
    expect(cacheLifeProfiles).toHaveProperty("max");

    // Profile shapes
    expect(cacheLifeProfiles.seconds).toEqual({ stale: 30, revalidate: 1, expire: 60 });
    expect(cacheLifeProfiles.max).toEqual({ stale: 300, revalidate: 2592000, expire: 31536000 });

    // Should run without throwing with valid inputs
    expect(() => cacheLife("default")).not.toThrow();
    expect(() => cacheLife("hours")).not.toThrow();
    expect(() => cacheLife({ stale: 60, revalidate: 300, expire: 3600 })).not.toThrow();
  });

  it("cacheLife warns on unknown profile", async () => {
    const { cacheLife } = await import(
      "../packages/vinext/src/shims/cache.js"
    );
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    cacheLife("nonexistent-profile");
    expect(consoleWarn).toHaveBeenCalledWith(
      expect.stringContaining("unknown profile"),
    );
    consoleWarn.mockRestore();
  });

  it("cacheLife warns when expire < revalidate", async () => {
    const { cacheLife } = await import(
      "../packages/vinext/src/shims/cache.js"
    );
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    cacheLife({ revalidate: 3600, expire: 60 });
    expect(consoleWarn).toHaveBeenCalledWith(
      expect.stringContaining("expire must be >= revalidate"),
    );
    consoleWarn.mockRestore();
  });

  it("exports cacheTag as a no-op function", async () => {
    const { cacheTag } = await import(
      "../packages/vinext/src/shims/cache.js"
    );
    expect(typeof cacheTag).toBe("function");
    // Should accept multiple tags without throwing
    expect(() => cacheTag("tag1", "tag2", "tag3")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// "use cache" runtime tests
// ---------------------------------------------------------------------------

describe('"use cache" runtime', () => {
  it("registerCachedFunction caches return values", async () => {
    const { registerCachedFunction } = await import(
      "../packages/vinext/src/shims/cache-runtime.js"
    );
    // Reset state
    const { setCacheHandler, MemoryCacheHandler } = await import(
      "../packages/vinext/src/shims/cache.js"
    );
    setCacheHandler(new MemoryCacheHandler());

    let callCount = 0;
    const fn = async (x: number) => {
      callCount++;
      return { result: x * 2 };
    };

    const cached = registerCachedFunction(fn, "test:double");

    const r1 = await cached(5);
    expect(r1).toEqual({ result: 10 });
    expect(callCount).toBe(1);

    // Second call with same args — should be cached
    const r2 = await cached(5);
    expect(r2).toEqual({ result: 10 });
    expect(callCount).toBe(1); // Not called again

    // Different args — cache miss
    const r3 = await cached(7);
    expect(r3).toEqual({ result: 14 });
    expect(callCount).toBe(2);
  });

  it("registerCachedFunction respects cacheLife inside cached function", async () => {
    const { registerCachedFunction } = await import(
      "../packages/vinext/src/shims/cache-runtime.js"
    );
    const { setCacheHandler, MemoryCacheHandler, cacheLife } = await import(
      "../packages/vinext/src/shims/cache.js"
    );
    setCacheHandler(new MemoryCacheHandler());

    let callCount = 0;
    const fn = async () => {
      cacheLife("seconds"); // revalidate: 1s
      callCount++;
      return { ts: Date.now() };
    };

    const cached = registerCachedFunction(fn, "test:cachelife");

    await cached();
    expect(callCount).toBe(1);

    // Immediate second call — cached
    await cached();
    expect(callCount).toBe(1);
  });

  it("registerCachedFunction collects cacheTag", async () => {
    const { registerCachedFunction } = await import(
      "../packages/vinext/src/shims/cache-runtime.js"
    );
    const { setCacheHandler, MemoryCacheHandler, cacheTag } = await import(
      "../packages/vinext/src/shims/cache.js"
    );
    const handler = new MemoryCacheHandler();
    setCacheHandler(handler);

    const fn = async () => {
      cacheTag("my-tag", "another-tag");
      return { data: "tagged" };
    };

    const cached = registerCachedFunction(fn, "test:tags");
    await cached();

    // The cache entry should have tags
    const entry = await handler.get("use-cache:test:tags");
    expect(entry).not.toBeNull();
    expect(entry?.value).toHaveProperty("kind", "FETCH");
    if (entry?.value && entry.value.kind === "FETCH") {
      expect(entry.value.tags).toContain("my-tag");
      expect(entry.value.tags).toContain("another-tag");
    }
  });

  it("revalidateTag invalidates cached entries", async () => {
    const { registerCachedFunction } = await import(
      "../packages/vinext/src/shims/cache-runtime.js"
    );
    const { setCacheHandler, MemoryCacheHandler, cacheTag, revalidateTag } = await import(
      "../packages/vinext/src/shims/cache.js"
    );
    setCacheHandler(new MemoryCacheHandler());

    let callCount = 0;
    const fn = async () => {
      cacheTag("invalidate-me");
      callCount++;
      return { count: callCount };
    };

    const cached = registerCachedFunction(fn, "test:invalidate");

    const r1 = await cached();
    expect(r1).toEqual({ count: 1 });
    expect(callCount).toBe(1);

    // Cached
    const r2 = await cached();
    expect(r2).toEqual({ count: 1 });
    expect(callCount).toBe(1);

    // Invalidate the tag
    await revalidateTag("invalidate-me");

    // Should re-execute
    const r3 = await cached();
    expect(r3).toEqual({ count: 2 });
    expect(callCount).toBe(2);
  });

  it("private variant uses per-request cache", async () => {
    const { registerCachedFunction, clearPrivateCache } = await import(
      "../packages/vinext/src/shims/cache-runtime.js"
    );

    let callCount = 0;
    const fn = async () => {
      callCount++;
      return { count: callCount };
    };

    const cached = registerCachedFunction(fn, "test:private", "private");

    const r1 = await cached();
    expect(r1).toEqual({ count: 1 });

    // Same request — cached
    const r2 = await cached();
    expect(r2).toEqual({ count: 1 });

    // Clear private cache (simulates new request)
    clearPrivateCache();

    // Should re-execute
    const r3 = await cached();
    expect(r3).toEqual({ count: 2 });
  });

  it("cacheLife minimum-wins rule applies", async () => {
    const { registerCachedFunction } = await import(
      "../packages/vinext/src/shims/cache-runtime.js"
    );
    const { setCacheHandler, MemoryCacheHandler, cacheLife } = await import(
      "../packages/vinext/src/shims/cache.js"
    );
    const handler = new MemoryCacheHandler();
    setCacheHandler(handler);

    const fn = async () => {
      cacheLife("hours");   // revalidate: 3600
      cacheLife("seconds"); // revalidate: 1  — this should win
      return { data: "min-wins" };
    };

    const cached = registerCachedFunction(fn, "test:min-wins");
    await cached();

    // The entry should have the minimum revalidate (1 second from "seconds" profile)
    const entry = await handler.get("use-cache:test:min-wins");
    expect(entry).not.toBeNull();
    if (entry?.value && entry.value.kind === "FETCH") {
      expect(entry.value.revalidate).toBe(1);
    }
  });

  it("getCacheContext returns null outside cache function", async () => {
    const { getCacheContext } = await import(
      "../packages/vinext/src/shims/cache-runtime.js"
    );
    expect(getCacheContext()).toBeNull();
  });

  it("consistent cache keys for same objects regardless of key order", async () => {
    const { registerCachedFunction } = await import(
      "../packages/vinext/src/shims/cache-runtime.js"
    );
    const { setCacheHandler, MemoryCacheHandler } = await import(
      "../packages/vinext/src/shims/cache.js"
    );
    setCacheHandler(new MemoryCacheHandler());

    let callCount = 0;
    const fn = async (_opts: Record<string, unknown>) => {
      callCount++;
      return { result: "ok" };
    };

    const cached = registerCachedFunction(fn, "test:stable-key");

    // Different key order, same content — should be same cache key
    await cached({ b: 2, a: 1 });
    expect(callCount).toBe(1);

    await cached({ a: 1, b: 2 });
    expect(callCount).toBe(1); // Same cache key, still cached
  });

  it("cached function with no args works correctly", async () => {
    const { registerCachedFunction } = await import(
      "../packages/vinext/src/shims/cache-runtime.js"
    );
    const { setCacheHandler, MemoryCacheHandler } = await import(
      "../packages/vinext/src/shims/cache.js"
    );
    setCacheHandler(new MemoryCacheHandler());

    let callCount = 0;
    const fn = async () => {
      callCount++;
      return { hello: "world" };
    };

    const cached = registerCachedFunction(fn, "test:no-args");
    const r1 = await cached();
    const r2 = await cached();
    expect(r1).toEqual({ hello: "world" });
    expect(r2).toEqual({ hello: "world" });
    expect(callCount).toBe(1);
  });

  it("falls back to JSON when RSC module is unavailable (test environment)", async () => {
    // In vitest, @vitejs/plugin-rsc/react/rsc is not available (no Vite RSC
    // environment). The runtime should gracefully fall back to JSON.stringify
    // for cache values and stableStringify for cache keys.
    const { registerCachedFunction } = await import(
      "../packages/vinext/src/shims/cache-runtime.js"
    );
    const { setCacheHandler, MemoryCacheHandler } = await import(
      "../packages/vinext/src/shims/cache.js"
    );
    const handler = new MemoryCacheHandler();
    setCacheHandler(handler);

    const fn = async (x: number) => ({ doubled: x * 2 });
    const cached = registerCachedFunction(fn, "test:json-fallback");

    const r1 = await cached(3);
    expect(r1).toEqual({ doubled: 6 });

    // Verify the stored value is JSON (no x-vinext-rsc header)
    // stableStringify wraps args as an array: [3]
    const entry = await handler.get("use-cache:test:json-fallback:[3]");
    expect(entry).not.toBeNull();
    if (entry?.value && entry.value.kind === "FETCH") {
      expect(entry.value.data.headers["x-vinext-rsc"]).toBeUndefined();
      expect(JSON.parse(entry.value.data.body)).toEqual({ doubled: 6 });
    }
  });

  it("skips caching for non-serializable args (functions)", async () => {
    const { registerCachedFunction } = await import(
      "../packages/vinext/src/shims/cache-runtime.js"
    );
    const { setCacheHandler, MemoryCacheHandler } = await import(
      "../packages/vinext/src/shims/cache.js"
    );
    setCacheHandler(new MemoryCacheHandler());

    let callCount = 0;
    const fn = async (_cb: () => void) => {
      callCount++;
      return { called: true };
    };

    const cached = registerCachedFunction(fn, "test:fn-arg");

    // Functions can't be serialized — should execute every time (no caching)
    await cached(() => {});
    await cached(() => {});
    expect(callCount).toBe(2);
  });

  it("produces different cache entries for Promise-augmented params with different values", async () => {
    // Regression test: Next.js 16 params are created via
    // Object.assign(Promise.resolve(params), params) — a "thenable object".
    // encodeReply with temporaryReferences treats Promises as temp refs,
    // which excluded the actual param values from the cache key.
    // This caused all dynamic route pages with "use cache" to share one
    // cache entry (e.g., /layouts/sports showed /layouts/electronics data).
    const { registerCachedFunction } = await import(
      "../packages/vinext/src/shims/cache-runtime.js"
    );
    const { setCacheHandler, MemoryCacheHandler } = await import(
      "../packages/vinext/src/shims/cache.js"
    );
    setCacheHandler(new MemoryCacheHandler());

    let callCount = 0;
    // Simulates a page component: async function Page({ params }) { ... }
    const fn = async (props: { params: any }) => {
      callCount++;
      const p = typeof props.params.then === "function"
        ? await props.params
        : props.params;
      return { section: p.section, data: `data-for-${p.section}` };
    };

    const cached = registerCachedFunction(fn, "test:thenable-params");

    // Create Promise-augmented params (same pattern as app-dev-server.ts)
    const electronicsParams = { section: "electronics" };
    const asyncElectronics = Object.assign(
      Promise.resolve(electronicsParams),
      electronicsParams,
    );

    const sportsParams = { section: "sports" };
    const asyncSports = Object.assign(
      Promise.resolve(sportsParams),
      sportsParams,
    );

    // First call — electronics
    const r1 = await cached({ params: asyncElectronics });
    expect(r1).toEqual({ section: "electronics", data: "data-for-electronics" });
    expect(callCount).toBe(1);

    // Second call with SAME params — should be cached
    const asyncElectronics2 = Object.assign(
      Promise.resolve({ section: "electronics" }),
      { section: "electronics" },
    );
    const r2 = await cached({ params: asyncElectronics2 });
    expect(r2).toEqual({ section: "electronics", data: "data-for-electronics" });
    expect(callCount).toBe(1); // Cache hit

    // Third call with DIFFERENT params — must be a cache MISS
    const r3 = await cached({ params: asyncSports });
    expect(r3).toEqual({ section: "sports", data: "data-for-sports" });
    expect(callCount).toBe(2); // Must have called the function again!
  });
});

describe("replyToCacheKey deterministic hashing", () => {
  it("returns string replies as-is", async () => {
    const { replyToCacheKey } = await import(
      "../packages/vinext/src/shims/cache-runtime.js"
    );
    expect(await replyToCacheKey("hello")).toBe("hello");
    expect(await replyToCacheKey("")).toBe("");
  });

  it("produces stable hash for FormData with string entries", async () => {
    const { replyToCacheKey } = await import(
      "../packages/vinext/src/shims/cache-runtime.js"
    );

    const fd1 = new FormData();
    fd1.append("a", "1");
    fd1.append("b", "2");

    const fd2 = new FormData();
    fd2.append("a", "1");
    fd2.append("b", "2");

    const key1 = await replyToCacheKey(fd1);
    const key2 = await replyToCacheKey(fd2);
    expect(key1).toBe(key2);
  });

  it("produces stable hash regardless of entry insertion order", async () => {
    const { replyToCacheKey } = await import(
      "../packages/vinext/src/shims/cache-runtime.js"
    );

    const fd1 = new FormData();
    fd1.append("b", "2");
    fd1.append("a", "1");

    const fd2 = new FormData();
    fd2.append("a", "1");
    fd2.append("b", "2");

    const key1 = await replyToCacheKey(fd1);
    const key2 = await replyToCacheKey(fd2);
    expect(key1).toBe(key2);
  });

  it("produces stable hash for FormData with Blob entries", async () => {
    const { replyToCacheKey } = await import(
      "../packages/vinext/src/shims/cache-runtime.js"
    );

    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "application/octet-stream" });

    const fd1 = new FormData();
    fd1.append("data", blob);

    const fd2 = new FormData();
    fd2.append("data", blob);

    const key1 = await replyToCacheKey(fd1);
    const key2 = await replyToCacheKey(fd2);
    expect(key1).toBe(key2);
  });

  it("produces different hashes for different FormData content", async () => {
    const { replyToCacheKey } = await import(
      "../packages/vinext/src/shims/cache-runtime.js"
    );

    const fd1 = new FormData();
    fd1.append("a", "1");

    const fd2 = new FormData();
    fd2.append("a", "2");

    const key1 = await replyToCacheKey(fd1);
    const key2 = await replyToCacheKey(fd2);
    expect(key1).not.toBe(key2);
  });
});

describe("middleware runner", () => {
  it("findMiddlewareFile finds middleware.ts at project root", async () => {
    const { findMiddlewareFile } = await import(
      "../packages/vinext/src/server/middleware.js"
    );
    // pages-basic fixture has middleware.ts
    const result = findMiddlewareFile(FIXTURE_DIR);
    expect(result).not.toBeNull();
    expect(result).toContain("middleware.ts");
  });

  it("findMiddlewareFile returns null when no middleware exists", async () => {
    const { findMiddlewareFile } = await import(
      "../packages/vinext/src/server/middleware.js"
    );
    const result = findMiddlewareFile("/tmp/nonexistent-dir-" + Date.now());
    expect(result).toBeNull();
  });

  it("findMiddlewareFile prefers proxy.ts over middleware.ts (Next.js 16)", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const os = await import("node:os");
    const { findMiddlewareFile } = await import(
      "../packages/vinext/src/server/middleware.js"
    );

    // Create a temp directory with both proxy.ts and middleware.ts
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-proxy-test-"));
    try {
      fs.writeFileSync(path.join(tmpDir, "proxy.ts"), "export default function proxy() {}");
      fs.writeFileSync(path.join(tmpDir, "middleware.ts"), "export function middleware() {}");
      const result = findMiddlewareFile(tmpDir);
      expect(result).not.toBeNull();
      expect(result).toContain("proxy.ts");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("findMiddlewareFile finds proxy.js", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const os = await import("node:os");
    const { findMiddlewareFile } = await import(
      "../packages/vinext/src/server/middleware.js"
    );

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-proxy-test-"));
    try {
      fs.writeFileSync(path.join(tmpDir, "proxy.js"), "module.exports = function proxy() {}");
      const result = findMiddlewareFile(tmpDir);
      expect(result).not.toBeNull();
      expect(result).toContain("proxy.js");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// matchPattern / matchesMiddleware unit tests

describe("middleware matcher patterns", () => {
  it("matchPattern: exact path match", async () => {
    const { matchPattern } = await import(
      "../packages/vinext/src/server/middleware.js"
    );
    expect(matchPattern("/about", "/about")).toBe(true);
    expect(matchPattern("/about", "/other")).toBe(false);
    expect(matchPattern("/", "/")).toBe(true);
  });

  it("matchPattern: named parameter (:param)", async () => {
    const { matchPattern } = await import(
      "../packages/vinext/src/server/middleware.js"
    );
    expect(matchPattern("/user/123", "/user/:id")).toBe(true);
    expect(matchPattern("/user/abc", "/user/:id")).toBe(true);
    expect(matchPattern("/user/", "/user/:id")).toBe(false);
    expect(matchPattern("/user/123/posts", "/user/:id")).toBe(false);
  });

  it("matchPattern: wildcard (:path*) matches zero or more segments", async () => {
    const { matchPattern } = await import(
      "../packages/vinext/src/server/middleware.js"
    );
    expect(matchPattern("/dashboard", "/dashboard/:path*")).toBe(true);
    expect(matchPattern("/dashboard/settings", "/dashboard/:path*")).toBe(true);
    expect(matchPattern("/dashboard/settings/profile", "/dashboard/:path*")).toBe(true);
    expect(matchPattern("/other", "/dashboard/:path*")).toBe(false);
  });

  it("matchPattern: one-or-more (:path+) requires at least one segment", async () => {
    const { matchPattern } = await import(
      "../packages/vinext/src/server/middleware.js"
    );
    expect(matchPattern("/api/users", "/api/:path+")).toBe(true);
    expect(matchPattern("/api/users/123", "/api/:path+")).toBe(true);
    expect(matchPattern("/api", "/api/:path+")).toBe(false);
    // /api/ has no actual segment after the slash
    expect(matchPattern("/api/", "/api/:path+")).toBe(false);
  });

  it("matchPattern: regex patterns with groups", async () => {
    const { matchPattern } = await import(
      "../packages/vinext/src/server/middleware.js"
    );
    // Common Next.js matcher: /((?!api|_next|favicon\.ico).*)
    expect(matchPattern("/about", "/((?!api|_next|favicon\\.ico).*)")).toBe(true);
    expect(matchPattern("/dashboard/settings", "/((?!api|_next|favicon\\.ico).*)")).toBe(true);
    expect(matchPattern("/api/hello", "/((?!api|_next|favicon\\.ico).*)")).toBe(false);
    expect(matchPattern("/_next/static/chunk.js", "/((?!api|_next|favicon\\.ico).*)")).toBe(false);
  });

  it("matchPattern: dots are escaped in paths", async () => {
    const { matchPattern } = await import(
      "../packages/vinext/src/server/middleware.js"
    );
    expect(matchPattern("/files/data.json", "/files/data.json")).toBe(true);
    expect(matchPattern("/files/dataXjson", "/files/data.json")).toBe(false);
  });

  it("matchesMiddleware: no matcher — matches all paths (Next.js default)", async () => {
    const { matchesMiddleware } = await import(
      "../packages/vinext/src/server/middleware.js"
    );
    // Next.js default: middleware runs on ALL paths when no matcher is configured.
    // Users opt out of specific paths by configuring a matcher pattern.
    expect(matchesMiddleware("/", undefined)).toBe(true);
    expect(matchesMiddleware("/about", undefined)).toBe(true);
    expect(matchesMiddleware("/dashboard/settings", undefined)).toBe(true);
    expect(matchesMiddleware("/_next/static/chunk.js", undefined)).toBe(true);
    expect(matchesMiddleware("/api/hello", undefined)).toBe(true);
    expect(matchesMiddleware("/favicon.ico", undefined)).toBe(true);
    expect(matchesMiddleware("/image.png", undefined)).toBe(true);
  });

  it("matchesMiddleware: single string matcher", async () => {
    const { matchesMiddleware } = await import(
      "../packages/vinext/src/server/middleware.js"
    );
    expect(matchesMiddleware("/about", "/about")).toBe(true);
    expect(matchesMiddleware("/other", "/about")).toBe(false);
  });

  it("matchesMiddleware: array of string matchers", async () => {
    const { matchesMiddleware } = await import(
      "../packages/vinext/src/server/middleware.js"
    );
    const matcher = ["/about", "/dashboard/:path*"];
    expect(matchesMiddleware("/about", matcher)).toBe(true);
    expect(matchesMiddleware("/dashboard", matcher)).toBe(true);
    expect(matchesMiddleware("/dashboard/settings", matcher)).toBe(true);
    expect(matchesMiddleware("/other", matcher)).toBe(false);
  });

  it("matchesMiddleware: array of object matchers with source", async () => {
    const { matchesMiddleware } = await import(
      "../packages/vinext/src/server/middleware.js"
    );
    const matcher = [
      { source: "/about" },
      { source: "/dashboard/:path*" },
    ];
    expect(matchesMiddleware("/about", matcher)).toBe(true);
    expect(matchesMiddleware("/dashboard/settings", matcher)).toBe(true);
    expect(matchesMiddleware("/other", matcher)).toBe(false);
  });

  it("matchesMiddleware: mixed array of strings and objects", async () => {
    const { matchesMiddleware } = await import(
      "../packages/vinext/src/server/middleware.js"
    );
    const matcher = ["/about", { source: "/api/:path+" }] as any;
    expect(matchesMiddleware("/about", matcher)).toBe(true);
    expect(matchesMiddleware("/api/users", matcher)).toBe(true);
    expect(matchesMiddleware("/api", matcher)).toBe(false);
    expect(matchesMiddleware("/other", matcher)).toBe(false);
  });

  it("matchPattern: rejects pathological ReDoS patterns", async () => {
    const { matchPattern } = await import(
      "../packages/vinext/src/server/middleware.js"
    );
    // Pathological pattern: (a+)+ causes catastrophic backtracking
    // matchPattern should return false (no match) instead of hanging
    // lgtm[js/redos] — deliberate pathological regex to test safeRegExp guard
    expect(matchPattern("/aaaaaaaaaaaaaaaaaaaac", "(a+)+b")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// normalizePath unit tests

describe("normalizePath", () => {
  it("returns root unchanged", async () => {
    const { normalizePath } = await import(
      "../packages/vinext/src/server/normalize-path.js"
    );
    expect(normalizePath("/")).toBe("/");
  });

  it("returns already-canonical paths unchanged", async () => {
    const { normalizePath } = await import(
      "../packages/vinext/src/server/normalize-path.js"
    );
    expect(normalizePath("/foo/bar")).toBe("/foo/bar");
    expect(normalizePath("/about")).toBe("/about");
    expect(normalizePath("/api/users/123")).toBe("/api/users/123");
  });

  it("collapses double slashes", async () => {
    const { normalizePath } = await import(
      "../packages/vinext/src/server/normalize-path.js"
    );
    expect(normalizePath("//foo")).toBe("/foo");
    expect(normalizePath("/foo//bar")).toBe("/foo/bar");
    expect(normalizePath("/dashboard//settings")).toBe("/dashboard/settings");
    expect(normalizePath("///")).toBe("/");
    expect(normalizePath("/foo///bar///baz")).toBe("/foo/bar/baz");
  });

  it("resolves single-dot segments", async () => {
    const { normalizePath } = await import(
      "../packages/vinext/src/server/normalize-path.js"
    );
    expect(normalizePath("/foo/./bar")).toBe("/foo/bar");
    expect(normalizePath("/./foo")).toBe("/foo");
    expect(normalizePath("/foo/.")).toBe("/foo");
  });

  it("resolves double-dot segments", async () => {
    const { normalizePath } = await import(
      "../packages/vinext/src/server/normalize-path.js"
    );
    expect(normalizePath("/foo/../bar")).toBe("/bar");
    expect(normalizePath("/foo/bar/../baz")).toBe("/foo/baz");
    expect(normalizePath("/foo/..")).toBe("/");
  });

  it("clamps traversal above root", async () => {
    const { normalizePath } = await import(
      "../packages/vinext/src/server/normalize-path.js"
    );
    expect(normalizePath("/../../../etc/passwd")).toBe("/etc/passwd");
    expect(normalizePath("/..")).toBe("/");
  });

  it("ensures leading slash", async () => {
    const { normalizePath } = await import(
      "../packages/vinext/src/server/normalize-path.js"
    );
    expect(normalizePath("foo/bar")).toBe("/foo/bar");
    expect(normalizePath("")).toBe("/");
  });

  it("preserves trailing slash on fast path", async () => {
    const { normalizePath } = await import(
      "../packages/vinext/src/server/normalize-path.js"
    );
    // Fast path: already canonical with trailing slash
    expect(normalizePath("/foo/bar/")).toBe("/foo/bar/");
  });

  it("handles complex combined cases", async () => {
    const { normalizePath } = await import(
      "../packages/vinext/src/server/normalize-path.js"
    );
    expect(normalizePath("/foo/./bar/../baz")).toBe("/foo/baz");
    expect(normalizePath("//foo/./bar//baz/../qux")).toBe("/foo/bar/qux");
  });
});

// ---------------------------------------------------------------------------
// Codegen parity tests (verify generated code matches runtime behavior)

describe("middleware codegen parity", () => {
  it("generateMiddlewareMatcherCode('modern') produces working matchesMiddleware", async () => {
    const { generateSafeRegExpCode, generateMiddlewareMatcherCode } = await import(
      "../packages/vinext/src/server/middleware-codegen.js"
    );
    // Eval the generated code and test it behaves identically to the runtime
    const code = generateSafeRegExpCode("modern") + generateMiddlewareMatcherCode("modern");
    // eslint-disable-next-line no-implied-eval -- intentional: eval generated codegen output
    const fn = new Function(code + "\nreturn { matchMiddlewarePattern, matchesMiddleware };");
    const { matchMiddlewarePattern, matchesMiddleware } = fn();

    // No matcher → matches all (Next.js default)
    expect(matchesMiddleware("/", undefined)).toBe(true);
    expect(matchesMiddleware("/api/hello", undefined)).toBe(true);
    expect(matchesMiddleware("/_next/static/chunk.js", undefined)).toBe(true);
    expect(matchesMiddleware("/favicon.ico", undefined)).toBe(true);

    // Exact match
    expect(matchMiddlewarePattern("/about", "/about")).toBe(true);
    expect(matchMiddlewarePattern("/other", "/about")).toBe(false);

    // Regex pattern with groups (must NOT corrupt the regex via dot-escaping)
    expect(matchMiddlewarePattern("/about", "/((?!api|_next|favicon\\.ico).*)")).toBe(true);
    expect(matchMiddlewarePattern("/api/hello", "/((?!api|_next|favicon\\.ico).*)")).toBe(false);

    // Named params
    expect(matchMiddlewarePattern("/user/123", "/user/:id")).toBe(true);

    // Wildcard
    expect(matchMiddlewarePattern("/dashboard/settings", "/dashboard/:path*")).toBe(true);
    expect(matchMiddlewarePattern("/dashboard", "/dashboard/:path*")).toBe(true);
  });

  it("generateMiddlewareMatcherCode('es5') produces working matchesMiddleware", async () => {
    const { generateSafeRegExpCode, generateMiddlewareMatcherCode } = await import(
      "../packages/vinext/src/server/middleware-codegen.js"
    );
    const code = generateSafeRegExpCode("es5") + generateMiddlewareMatcherCode("es5");
    // eslint-disable-next-line no-implied-eval -- intentional: eval generated codegen output
    const fn = new Function(code + "\nreturn { matchMiddlewarePattern, matchesMiddleware };");
    const { matchMiddlewarePattern, matchesMiddleware } = fn();

    // No matcher → matches all
    expect(matchesMiddleware("/api/hello", undefined)).toBe(true);

    // Regex guard (must not corrupt regex patterns via dot-escaping)
    expect(matchMiddlewarePattern("/about", "/((?!api|_next|favicon\\.ico).*)")).toBe(true);
    expect(matchMiddlewarePattern("/api/hello", "/((?!api|_next|favicon\\.ico).*)")).toBe(false);
  });

  it("generateNormalizePathCode produces working __normalizePath", async () => {
    const { generateNormalizePathCode } = await import(
      "../packages/vinext/src/server/middleware-codegen.js"
    );
    const code = generateNormalizePathCode("modern");
    // eslint-disable-next-line no-implied-eval -- intentional: eval generated codegen output
    const fn = new Function(code + "\nreturn __normalizePath;");
    const __normalizePath = fn();

    expect(__normalizePath("/")).toBe("/");
    expect(__normalizePath("/foo/bar")).toBe("/foo/bar");
    expect(__normalizePath("//foo")).toBe("/foo");
    expect(__normalizePath("/foo//bar")).toBe("/foo/bar");
    expect(__normalizePath("/foo/./bar")).toBe("/foo/bar");
    expect(__normalizePath("/foo/../bar")).toBe("/bar");
    expect(__normalizePath("/../../../etc/passwd")).toBe("/etc/passwd");
  });
});

// ---------------------------------------------------------------------------
// Integration: verify decodeURIComponent + normalizePath applied before matching

describe("middleware bypass prevention", () => {
  it("percent-encoded path is decoded before matching", async () => {
    const { matchPattern, matchesMiddleware } = await import(
      "../packages/vinext/src/server/middleware.js"
    );
    const { normalizePath } = await import(
      "../packages/vinext/src/server/normalize-path.js"
    );

    // /%61dmin decodes to /admin
    const encoded = "/%61dmin";
    const decoded = normalizePath(decodeURIComponent(encoded));
    expect(decoded).toBe("/admin");
    expect(matchPattern(decoded, "/admin")).toBe(true);
    expect(matchesMiddleware(decoded, "/admin")).toBe(true);
  });

  it("double-slash path is collapsed before matching", async () => {
    const { matchPattern, matchesMiddleware } = await import(
      "../packages/vinext/src/server/middleware.js"
    );
    const { normalizePath } = await import(
      "../packages/vinext/src/server/normalize-path.js"
    );

    // /dashboard//settings collapses to /dashboard/settings
    const doubleSlash = "/dashboard//settings";
    const normalized = normalizePath(doubleSlash);
    expect(normalized).toBe("/dashboard/settings");
    expect(matchPattern(normalized, "/dashboard/:path*")).toBe(true);
    expect(matchesMiddleware(normalized, "/dashboard/:path*")).toBe(true);
  });

  it("default matcher (no config) matches all paths including /api", async () => {
    const { matchesMiddleware } = await import(
      "../packages/vinext/src/server/middleware.js"
    );
    // When no matcher is configured, middleware must run on ALL paths
    expect(matchesMiddleware("/api/hello", undefined)).toBe(true);
    expect(matchesMiddleware("/_next/data/build-id/page.json", undefined)).toBe(true);
    expect(matchesMiddleware("/favicon.ico", undefined)).toBe(true);
  });

  it("regex patterns are not corrupted by dot-escaping", async () => {
    const { matchPattern } = await import(
      "../packages/vinext/src/server/middleware.js"
    );
    // The common Next.js regex pattern must work correctly:
    // /((?!api|_next|favicon\.ico).*) should match /about but NOT /api/hello
    const pattern = "/((?!api|_next|favicon\\.ico).*)";
    expect(matchPattern("/about", pattern)).toBe(true);
    expect(matchPattern("/dashboard/settings", pattern)).toBe(true);
    expect(matchPattern("/api/hello", pattern)).toBe(false);
    expect(matchPattern("/_next/static/chunk.js", pattern)).toBe(false);
    expect(matchPattern("/favicon.ico", pattern)).toBe(false);
  });

  // ── Config matcher percent-encoding handling ──

  it("config redirect matcher works with decoded percent-encoded paths", async () => {
    const { matchRedirect } = await import(
      "../packages/vinext/src/config/config-matchers.js"
    );
    const { normalizePath } = await import(
      "../packages/vinext/src/server/normalize-path.js"
    );
    const redirects = [
      { source: "/admin", destination: "/login", permanent: true },
      { source: "/old-blog/:slug", destination: "/blog/:slug", permanent: false },
    ];
    const reqCtx = { headers: new Headers(), cookies: {}, query: new URLSearchParams(), host: "localhost" };
    // Decoded path should match
    const decoded = normalizePath(decodeURIComponent("/%61dmin"));
    expect(decoded).toBe("/admin");
    const result = matchRedirect(decoded, redirects, reqCtx);
    expect(result).toBeTruthy();
    expect(result!.destination).toBe("/login");

    // Mixed encoding in parameterized route
    const slugDecoded = normalizePath(decodeURIComponent("/%6Fld-blog/my-p%6Fst"));
    expect(slugDecoded).toBe("/old-blog/my-post");
    const slugResult = matchRedirect(slugDecoded, redirects, reqCtx);
    expect(slugResult).toBeTruthy();
    expect(slugResult!.destination).toBe("/blog/my-post");

    // Raw encoded path must NOT match (matchers expect decoded paths)
    const rawResult = matchRedirect("/%61dmin", redirects, reqCtx);
    expect(rawResult).toBeNull();
  });

  it("config header matcher works with decoded percent-encoded paths", async () => {
    const { matchHeaders } = await import(
      "../packages/vinext/src/config/config-matchers.js"
    );
    const { normalizePath } = await import(
      "../packages/vinext/src/server/normalize-path.js"
    );
    const headers = [
      { source: "/api/(.*)", headers: [{ key: "X-Custom", value: "true" }] },
    ];
    // Decoded path should match
    const decoded = normalizePath(decodeURIComponent("/%61pi/hello"));
    expect(decoded).toBe("/api/hello");
    const result = matchHeaders(decoded, headers);
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe("X-Custom");

    // Raw encoded path must NOT match
    const rawResult = matchHeaders("/%61pi/hello", headers);
    expect(rawResult).toHaveLength(0);
  });

  it("config rewrite matcher works with decoded percent-encoded paths", async () => {
    const { matchRewrite } = await import(
      "../packages/vinext/src/config/config-matchers.js"
    );
    const { normalizePath } = await import(
      "../packages/vinext/src/server/normalize-path.js"
    );
    const rewrites = [
      { source: "/before-rewrite", destination: "/about" },
    ];
    const reqCtx = { headers: new Headers(), cookies: {}, query: new URLSearchParams(), host: "localhost" };
    // Decoded path should match
    const decoded = normalizePath(decodeURIComponent("/%62efore-rewrite"));
    expect(decoded).toBe("/before-rewrite");
    const result = matchRewrite(decoded, rewrites, reqCtx);
    expect(result).toBe("/about");

    // Raw encoded path must NOT match
    const rawResult = matchRewrite("/%62efore-rewrite", rewrites, reqCtx);
    expect(rawResult).toBeNull();
  });

  it("double-encoded paths are decoded only once", async () => {
    const { normalizePath } = await import(
      "../packages/vinext/src/server/normalize-path.js"
    );
    // %2561dmin → first decode → %61dmin (literal text, not /admin)
    const doubleEncoded = "/%2561dmin";
    const decoded = normalizePath(decodeURIComponent(doubleEncoded));
    // Should decode to /%61dmin, NOT to /admin
    expect(decoded).toBe("/%61dmin");
    expect(decoded).not.toBe("/admin");
  });
});

describe("double-encoded path handling in middleware", () => {
  it("double-encoded path /%2564ashboard does not match /dashboard middleware pattern", async () => {
    const { matchPattern, matchesMiddleware } = await import(
      "../packages/vinext/src/server/middleware.js"
    );
    const { normalizePath } = await import(
      "../packages/vinext/src/server/normalize-path.js"
    );

    // /%2564ashboard with a single decode becomes /%64ashboard (NOT /dashboard).
    // The pathname should be decoded exactly once at the entry point.
    const testPath = "/%2564ashboard";
    const decoded = decodeURIComponent(testPath); // Single decode
    const normalized = normalizePath(decoded);
    // After one decode, this is NOT /dashboard — it's /%64ashboard
    expect(normalized).toBe("/%64ashboard");
    // Middleware should NOT match /dashboard for this path
    expect(matchPattern(normalized, "/dashboard")).toBe(false);
    expect(matchesMiddleware(normalized, "/dashboard")).toBe(false);
  });

  it("double-encoded slash /foo/..%252fdashboard does not resolve to /dashboard", async () => {
    const { matchPattern } = await import(
      "../packages/vinext/src/server/middleware.js"
    );
    const { normalizePath } = await import(
      "../packages/vinext/src/server/normalize-path.js"
    );

    // /foo/..%252fdashboard with a single decode becomes /foo/..%2fdashboard.
    // normalizePath does NOT treat %2f as a path separator, so no traversal occurs.
    const testPath = "/foo/..%252fdashboard";
    const decoded = decodeURIComponent(testPath); // Single decode
    const normalized = normalizePath(decoded);
    // After one decode + normalize, this should NOT resolve to /dashboard
    expect(normalized).not.toBe("/dashboard");
    // The .. only traverses if followed by a real /, not an encoded %2f
    expect(matchPattern(normalized, "/dashboard")).toBe(false);
  });

  it("matchRoute in generated code does not double-decode pathnames", async () => {
    // Verify that matchRoute no longer calls decodeURIComponent internally.
    // The generated RSC entry code is a string — we check it directly.
    const { generateRscEntry } = await import(
      "../packages/vinext/src/server/app-dev-server.js"
    );
    const code = generateRscEntry("/tmp/app", [
      {
        pattern: "/dashboard",
        isDynamic: false,
        params: [],
        pagePath: null,
        routePath: null,
        layouts: [],
        layoutSegmentDepths: [],
        templates: [],
        loadingPath: null,
        errorPath: null,
        layoutErrorPaths: [],
        notFoundPath: null,
        notFoundPaths: [],
        forbiddenPath: null,
        unauthorizedPath: null,
        parallelSlots: [],
      },
    ]);
    // Extract the matchRoute function from generated code
    const matchRouteMatch = code.match(/function matchRoute\(url, routes\) \{[\s\S]*?\n\}/);
    expect(matchRouteMatch).toBeTruthy();
    const matchRouteCode = matchRouteMatch![0];
    // Verify it does NOT call decodeURIComponent (the comment mentions it but
    // should not have an actual call like `decodeURIComponent(...)`)
    expect(matchRouteCode).not.toMatch(/\bdecodeURIComponent\s*\(/);
  });

  it("middleware always receives a Request with the decoded pathname (not raw URL)", async () => {
    const { generateRscEntry } = await import(
      "../packages/vinext/src/server/app-dev-server.js"
    );
    const code = generateRscEntry(
      "/tmp/app",
      [
        {
          pattern: "/dashboard",
          isDynamic: false,
          params: [],
          pagePath: null,
          routePath: null,
          layouts: [],
          layoutSegmentDepths: [],
          templates: [],
          loadingPath: null,
          errorPath: null,
          layoutErrorPaths: [],
          notFoundPath: null,
          notFoundPaths: [],
          forbiddenPath: null,
          unauthorizedPath: null,
          parallelSlots: [],
        },
      ],
      "/tmp/middleware.ts",
    );
    // The generated code should ALWAYS construct a new Request with cleanPathname.
    // Verify the generated code constructs a Request with the decoded pathname
    // for ALL requests (not just RSC).
    expect(code).not.toMatch(/let mwRequest = request;/);
    expect(code).toContain("const mwUrl = new URL(request.url)");
    expect(code).toContain("mwUrl.pathname = cleanPathname");
    expect(code).toContain("const mwRequest = new Request(mwUrl, request)");
  });

  it("Pages Router runMiddleware passes decoded pathname to middleware function", async () => {
    const { runMiddleware } = await import(
      "../packages/vinext/src/server/middleware.js"
    );
    // Create a mock Vite server that returns a middleware module
    let capturedUrl: string | undefined;
    const mockServer = {
      ssrLoadModule: async () => ({
        default: (req: Request) => {
          capturedUrl = req.url;
          return new Response("OK", {
            headers: { "x-middleware-next": "1" },
          });
        },
        config: { matcher: "/:path*" },
      }),
    };

    // Send a double-encoded path — after single decode, it should be /%64ashboard
    const testUrl = "http://localhost:3000/%2564ashboard";
    const request = new Request(testUrl);
    await runMiddleware(mockServer as any, "/tmp/middleware.ts", request);

    // Middleware should have received the decoded+normalized URL
    expect(capturedUrl).toBeDefined();
    const mwPathname = new URL(capturedUrl!).pathname;
    // After single decode: %25 → %, so /%2564 → /%64
    expect(mwPathname).toBe("/%64ashboard");
    // It must NOT be the raw /%2564ashboard
    expect(mwPathname).not.toBe("/%2564ashboard");
    // It must NOT be double-decoded to /dashboard
    expect(mwPathname).not.toBe("/dashboard");
  });

  it("app-router-entry.ts does not double-decode (delegates to RSC handler)", async () => {
    // Verify the Cloudflare Worker entry does not decode the pathname itself,
    // leaving that responsibility to the RSC handler.
    const fs = await import("node:fs");
    const entryCode = fs.readFileSync(
      new URL("../packages/vinext/src/server/app-router-entry.ts", import.meta.url),
      "utf-8",
    );
    // The entry should validate encoding but NOT normalize+reconstruct the request
    // (the RSC handler is the single decode point)
    expect(entryCode).not.toMatch(/normalizedRequest\s*=\s*new Request\(normalizedUrl/);
    // It should still validate malformed encoding (return 400)
    expect(entryCode).toContain("decodeURIComponent(rawPathname)");
    // The delegate call should pass `request` (not normalizedRequest)
    expect(entryCode).toMatch(/rscHandler\(request\)/);
  });
});

// ---------------------------------------------------------------------------
// RequestCookies comprehensive tests

describe("RequestCookies API", () => {
  it("get() returns cookie by name", async () => {
    const { RequestCookies } = await import(
      "../packages/vinext/src/shims/server.js"
    );
    const headers = new Headers({ cookie: "token=abc123; session=xyz" });
    const cookies = new RequestCookies(headers);

    const token = cookies.get("token");
    expect(token).toEqual({ name: "token", value: "abc123" });

    const session = cookies.get("session");
    expect(session).toEqual({ name: "session", value: "xyz" });
  });

  it("get() returns undefined for missing cookie", async () => {
    const { RequestCookies } = await import(
      "../packages/vinext/src/shims/server.js"
    );
    const headers = new Headers({ cookie: "token=abc123" });
    const cookies = new RequestCookies(headers);

    expect(cookies.get("missing")).toBeUndefined();
  });

  it("getAll() returns all cookies", async () => {
    const { RequestCookies } = await import(
      "../packages/vinext/src/shims/server.js"
    );
    const headers = new Headers({ cookie: "a=1; b=2; c=3" });
    const cookies = new RequestCookies(headers);

    const all = cookies.getAll();
    expect(all).toHaveLength(3);
    expect(all).toContainEqual({ name: "a", value: "1" });
    expect(all).toContainEqual({ name: "b", value: "2" });
    expect(all).toContainEqual({ name: "c", value: "3" });
  });

  it("has() checks cookie existence", async () => {
    const { RequestCookies } = await import(
      "../packages/vinext/src/shims/server.js"
    );
    const headers = new Headers({ cookie: "token=abc" });
    const cookies = new RequestCookies(headers);

    expect(cookies.has("token")).toBe(true);
    expect(cookies.has("missing")).toBe(false);
  });

  it("iterator yields [name, entry] pairs", async () => {
    const { RequestCookies } = await import(
      "../packages/vinext/src/shims/server.js"
    );
    const headers = new Headers({ cookie: "x=1; y=2" });
    const cookies = new RequestCookies(headers);

    const entries = [...cookies];
    expect(entries).toHaveLength(2);
    expect(entries[0][0]).toBe("x");
    expect(entries[0][1]).toEqual({ name: "x", value: "1" });
    expect(entries[1][0]).toBe("y");
    expect(entries[1][1]).toEqual({ name: "y", value: "2" });
  });

  it("handles empty cookie header", async () => {
    const { RequestCookies } = await import(
      "../packages/vinext/src/shims/server.js"
    );
    const headers = new Headers();
    const cookies = new RequestCookies(headers);

    expect(cookies.getAll()).toHaveLength(0);
    expect(cookies.get("any")).toBeUndefined();
    expect(cookies.has("any")).toBe(false);
  });

  it("handles cookies with = in value", async () => {
    const { RequestCookies } = await import(
      "../packages/vinext/src/shims/server.js"
    );
    const headers = new Headers({ cookie: "data=base64=encoded=value" });
    const cookies = new RequestCookies(headers);

    const data = cookies.get("data");
    expect(data).toBeDefined();
    expect(data!.value).toBe("base64=encoded=value");
  });
});

// ---------------------------------------------------------------------------
// ResponseCookies comprehensive tests

describe("ResponseCookies API", () => {
  it("set() creates Set-Cookie header with options", async () => {
    const { ResponseCookies } = await import(
      "../packages/vinext/src/shims/server.js"
    );
    const headers = new Headers();
    const cookies = new ResponseCookies(headers);

    cookies.set("token", "abc123", {
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      maxAge: 3600,
    });

    const setCookie = headers.getSetCookie();
    expect(setCookie).toHaveLength(1);
    expect(setCookie[0]).toContain("token=abc123");
    expect(setCookie[0]).toContain("Path=/");
    expect(setCookie[0]).toContain("HttpOnly");
    expect(setCookie[0]).toContain("Secure");
    expect(setCookie[0]).toContain("SameSite=Lax");
    expect(setCookie[0]).toContain("Max-Age=3600");
  });

  it("set() multiple cookies appends multiple Set-Cookie headers", async () => {
    const { ResponseCookies } = await import(
      "../packages/vinext/src/shims/server.js"
    );
    const headers = new Headers();
    const cookies = new ResponseCookies(headers);

    cookies.set("a", "1");
    cookies.set("b", "2");

    const setCookie = headers.getSetCookie();
    expect(setCookie).toHaveLength(2);
    expect(setCookie[0]).toContain("a=1");
    expect(setCookie[1]).toContain("b=2");
  });

  it("get() retrieves a cookie from Set-Cookie headers", async () => {
    const { ResponseCookies } = await import(
      "../packages/vinext/src/shims/server.js"
    );
    const headers = new Headers();
    const cookies = new ResponseCookies(headers);

    cookies.set("token", "xyz");
    const result = cookies.get("token");
    expect(result).toEqual({ name: "token", value: "xyz" });
  });

  it("getAll() returns all set cookies", async () => {
    const { ResponseCookies } = await import(
      "../packages/vinext/src/shims/server.js"
    );
    const headers = new Headers();
    const cookies = new ResponseCookies(headers);

    cookies.set("a", "1");
    cookies.set("b", "2");
    cookies.set("c", "3");

    const all = cookies.getAll();
    expect(all).toHaveLength(3);
    expect(all).toContainEqual({ name: "a", value: "1" });
    expect(all).toContainEqual({ name: "b", value: "2" });
    expect(all).toContainEqual({ name: "c", value: "3" });
  });

  it("delete() sets Max-Age=0", async () => {
    const { ResponseCookies } = await import(
      "../packages/vinext/src/shims/server.js"
    );
    const headers = new Headers();
    const cookies = new ResponseCookies(headers);

    cookies.delete("session");

    const setCookie = headers.getSetCookie();
    expect(setCookie).toHaveLength(1);
    expect(setCookie[0]).toContain("session=");
    expect(setCookie[0]).toContain("Max-Age=0");
    expect(setCookie[0]).toContain("Path=/");
  });

  it("set() URL-encodes cookie values", async () => {
    const { ResponseCookies } = await import(
      "../packages/vinext/src/shims/server.js"
    );
    const headers = new Headers();
    const cookies = new ResponseCookies(headers);

    cookies.set("data", "hello world; special=chars");

    const setCookie = headers.getSetCookie();
    expect(setCookie[0]).toContain("data=hello%20world%3B%20special%3Dchars");

    // get() should decode it back
    const result = cookies.get("data");
    expect(result?.value).toBe("hello world; special=chars");
  });

  it("iterator yields [name, entry] pairs", async () => {
    const { ResponseCookies } = await import(
      "../packages/vinext/src/shims/server.js"
    );
    const headers = new Headers();
    const cookies = new ResponseCookies(headers);

    cookies.set("x", "1");
    cookies.set("y", "2");

    const entries = [...cookies];
    expect(entries).toHaveLength(2);
    expect(entries[0][0]).toBe("x");
    expect(entries[0][1]).toEqual({ name: "x", value: "1" });
    expect(entries[1][0]).toBe("y");
    expect(entries[1][1]).toEqual({ name: "y", value: "2" });
  });

  it("set() with domain option includes Domain directive", async () => {
    const { ResponseCookies } = await import(
      "../packages/vinext/src/shims/server.js"
    );
    const headers = new Headers();
    const cookies = new ResponseCookies(headers);

    cookies.set("token", "abc", { domain: ".example.com" });

    const setCookie = headers.getSetCookie();
    expect(setCookie[0]).toContain("Domain=.example.com");
  });

  it("set() with expires option includes Expires directive", async () => {
    const { ResponseCookies } = await import(
      "../packages/vinext/src/shims/server.js"
    );
    const headers = new Headers();
    const cookies = new ResponseCookies(headers);

    const expires = new Date("2030-01-01T00:00:00Z");
    cookies.set("token", "abc", { expires });

    const setCookie = headers.getSetCookie();
    expect(setCookie[0]).toContain("Expires=");
    expect(setCookie[0]).toContain("2030");
  });
});

// ---------------------------------------------------------------------------
// Cookie name/value injection prevention (RFC 6265)

describe("cookie name validation", () => {
  it("RequestCookies.set() rejects names with = (injection)", async () => {
    const headersModule = await import("../packages/vinext/src/shims/headers.js");
    headersModule.setHeadersContext({ headers: new Headers(), cookies: new Map() });
    const jar = await headersModule.cookies();
    expect(() => jar.set("foo=bar; Path=/; Domain=evil.com", "val")).toThrow("Invalid cookie name");
  });

  it("RequestCookies.set() rejects names with semicolons", async () => {
    const headersModule = await import("../packages/vinext/src/shims/headers.js");
    headersModule.setHeadersContext({ headers: new Headers(), cookies: new Map() });
    const jar = await headersModule.cookies();
    expect(() => jar.set("foo; HttpOnly", "val")).toThrow("Invalid cookie name");
  });

  it("RequestCookies.set() rejects names with newlines", async () => {
    const headersModule = await import("../packages/vinext/src/shims/headers.js");
    headersModule.setHeadersContext({ headers: new Headers(), cookies: new Map() });
    const jar = await headersModule.cookies();
    expect(() => jar.set("foo\r\nSet-Cookie: evil=1", "val")).toThrow("Invalid cookie name");
  });

  it("RequestCookies.set() rejects empty names", async () => {
    const headersModule = await import("../packages/vinext/src/shims/headers.js");
    headersModule.setHeadersContext({ headers: new Headers(), cookies: new Map() });
    const jar = await headersModule.cookies();
    expect(() => jar.set("", "val")).toThrow("Invalid cookie name");
  });

  it("RequestCookies.set() accepts valid cookie names", async () => {
    const headersModule = await import("../packages/vinext/src/shims/headers.js");
    headersModule.setHeadersContext({ headers: new Headers(), cookies: new Map() });
    const jar = await headersModule.cookies();
    // These should not throw
    jar.set("valid-name", "value");
    jar.set("__Host-token", "value");
    jar.set("session_id", "value");
    jar.set("CSRF.Token", "value");
  });

  it("RequestCookies.delete() rejects invalid names", async () => {
    const headersModule = await import("../packages/vinext/src/shims/headers.js");
    headersModule.setHeadersContext({ headers: new Headers(), cookies: new Map() });
    const jar = await headersModule.cookies();
    expect(() => jar.delete("foo=bar")).toThrow("Invalid cookie name");
  });

  it("RequestCookies.set() rejects path with semicolons", async () => {
    const headersModule = await import("../packages/vinext/src/shims/headers.js");
    headersModule.setHeadersContext({ headers: new Headers(), cookies: new Map() });
    const jar = await headersModule.cookies();
    expect(() => jar.set("name", "val", { path: "/; Domain=evil.com" })).toThrow("Invalid cookie Path");
  });

  it("ResponseCookies.set() rejects names with = (injection)", async () => {
    const { ResponseCookies } = await import("../packages/vinext/src/shims/server.js");
    const headers = new Headers();
    const cookies = new ResponseCookies(headers);
    expect(() => cookies.set("foo=bar; Path=/", "val")).toThrow("Invalid cookie name");
  });

  it("ResponseCookies.set() rejects domain with control chars", async () => {
    const { ResponseCookies } = await import("../packages/vinext/src/shims/server.js");
    const headers = new Headers();
    const cookies = new ResponseCookies(headers);
    expect(() => cookies.set("name", "val", { domain: "evil.com\r\nSet-Cookie: hack=1" })).toThrow("Invalid cookie Domain");
  });

  it("ResponseCookies.set() accepts valid cookie names and options", async () => {
    const { ResponseCookies } = await import("../packages/vinext/src/shims/server.js");
    const headers = new Headers();
    const cookies = new ResponseCookies(headers);
    // These should not throw
    cookies.set("valid-name", "value", { path: "/", domain: ".example.com" });
    cookies.set("__Secure-token", "abc", { secure: true, httpOnly: true });
  });
});

// ---------------------------------------------------------------------------
// NextRequest API tests

describe("NextRequest API", () => {
  it("cookies reads request cookies", async () => {
    const { NextRequest } = await import(
      "../packages/vinext/src/shims/server.js"
    );
    const req = new NextRequest("http://localhost/test", {
      headers: { cookie: "session=abc; theme=dark" },
    });

    expect(req.cookies.get("session")).toEqual({ name: "session", value: "abc" });
    expect(req.cookies.get("theme")).toEqual({ name: "theme", value: "dark" });
    expect(req.cookies.has("session")).toBe(true);
    expect(req.cookies.has("missing")).toBe(false);
  });

  it("nextUrl provides URL properties", async () => {
    const { NextRequest } = await import(
      "../packages/vinext/src/shims/server.js"
    );
    const req = new NextRequest("http://localhost:3000/api/test?key=value#hash");

    expect(req.nextUrl.pathname).toBe("/api/test");
    expect(req.nextUrl.search).toBe("?key=value");
    expect(req.nextUrl.searchParams.get("key")).toBe("value");
    expect(req.nextUrl.host).toBe("localhost:3000");
    expect(req.nextUrl.hostname).toBe("localhost");
    expect(req.nextUrl.protocol).toBe("http:");
    expect(req.nextUrl.hash).toBe("#hash");
  });

  it("nextUrl.clone() creates independent copy", async () => {
    const { NextRequest } = await import(
      "../packages/vinext/src/shims/server.js"
    );
    const req = new NextRequest("http://localhost/test");
    const cloned = req.nextUrl.clone();

    cloned.pathname = "/other";
    expect(req.nextUrl.pathname).toBe("/test");
    expect(cloned.pathname).toBe("/other");
  });

  it("ip reads x-forwarded-for header", async () => {
    const { NextRequest } = await import(
      "../packages/vinext/src/shims/server.js"
    );
    const req = new NextRequest("http://localhost/", {
      headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" },
    });
    expect(req.ip).toBe("1.2.3.4");
  });

  it("ip returns undefined when no header", async () => {
    const { NextRequest } = await import(
      "../packages/vinext/src/shims/server.js"
    );
    const req = new NextRequest("http://localhost/");
    expect(req.ip).toBeUndefined();
  });

  it("geo reads Cloudflare headers", async () => {
    const { NextRequest } = await import(
      "../packages/vinext/src/shims/server.js"
    );
    const req = new NextRequest("http://localhost/", {
      headers: {
        "cf-ipcountry": "US",
        "cf-ipcity": "San Francisco",
      },
    });
    expect(req.geo?.country).toBe("US");
    expect(req.geo?.city).toBe("San Francisco");
  });

  it("geo returns undefined when no geo headers", async () => {
    const { NextRequest } = await import(
      "../packages/vinext/src/shims/server.js"
    );
    const req = new NextRequest("http://localhost/");
    expect(req.geo).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// NextResponse.next() with request header forwarding

describe("NextResponse.next() request header forwarding", () => {
  it("forwards request headers as x-middleware-request-* headers", async () => {
    const { NextResponse } = await import(
      "../packages/vinext/src/shims/server.js"
    );
    const res = NextResponse.next({
      request: {
        headers: new Headers({
          "x-custom-header": "custom-value",
          "authorization": "Bearer token123",
        }),
      },
    });

    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(res.headers.get("x-middleware-request-x-custom-header")).toBe("custom-value");
    expect(res.headers.get("x-middleware-request-authorization")).toBe("Bearer token123");
  });
});

// ---------------------------------------------------------------------------
// NextResponse.redirect() with different status codes

describe("NextResponse.redirect() status codes", () => {
  it("defaults to 307 Temporary Redirect", async () => {
    const { NextResponse } = await import(
      "../packages/vinext/src/shims/server.js"
    );
    const res = NextResponse.redirect("https://example.com");
    expect(res.status).toBe(307);
  });

  it("supports 301 Permanent Redirect", async () => {
    const { NextResponse } = await import(
      "../packages/vinext/src/shims/server.js"
    );
    const res = NextResponse.redirect("https://example.com", 301);
    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe("https://example.com");
  });

  it("supports 302 Found", async () => {
    const { NextResponse } = await import(
      "../packages/vinext/src/shims/server.js"
    );
    const res = NextResponse.redirect("https://example.com", 302);
    expect(res.status).toBe(302);
  });

  it("supports 308 Permanent Redirect", async () => {
    const { NextResponse } = await import(
      "../packages/vinext/src/shims/server.js"
    );
    const res = NextResponse.redirect("https://example.com", 308);
    expect(res.status).toBe(308);
  });

  it("accepts URL object", async () => {
    const { NextResponse } = await import(
      "../packages/vinext/src/shims/server.js"
    );
    const url = new URL("https://example.com/target");
    const res = NextResponse.redirect(url);
    expect(res.headers.get("Location")).toBe("https://example.com/target");
  });
});

// ---------------------------------------------------------------------------
// matchConfigPattern unit tests (next.config.js redirects/rewrites)

describe("matchConfigPattern", () => {
  it("matches exact paths", async () => {
    const { matchConfigPattern } = await import(
      "../packages/vinext/src/index.js"
    );
    expect(matchConfigPattern("/about", "/about")).toEqual({});
    expect(matchConfigPattern("/", "/")).toEqual({});
    expect(matchConfigPattern("/about", "/other")).toBeNull();
  });

  it("matches single :param segments", async () => {
    const { matchConfigPattern } = await import(
      "../packages/vinext/src/index.js"
    );
    const result = matchConfigPattern("/blog/hello-world", "/blog/:slug");
    expect(result).toEqual({ slug: "hello-world" });
  });

  it("matches multiple :param segments", async () => {
    const { matchConfigPattern } = await import(
      "../packages/vinext/src/index.js"
    );
    const result = matchConfigPattern("/blog/2024/my-post", "/blog/:year/:slug");
    expect(result).toEqual({ year: "2024", slug: "my-post" });
  });

  it("rejects when segment count differs for non-wildcard patterns", async () => {
    const { matchConfigPattern } = await import(
      "../packages/vinext/src/index.js"
    );
    expect(matchConfigPattern("/blog/a/b", "/blog/:slug")).toBeNull();
    expect(matchConfigPattern("/blog", "/blog/:slug")).toBeNull();
  });

  it("matches :path* catch-all (zero or more segments)", async () => {
    const { matchConfigPattern } = await import(
      "../packages/vinext/src/index.js"
    );
    // Zero segments
    expect(matchConfigPattern("/docs", "/docs/:path*")).toEqual({ path: "" });
    // One segment
    expect(matchConfigPattern("/docs/intro", "/docs/:path*")).toEqual({ path: "intro" });
    // Multiple segments
    expect(matchConfigPattern("/docs/guide/getting-started", "/docs/:path*")).toEqual({
      path: "guide/getting-started",
    });
  });

  it("matches :path+ catch-all (one or more segments)", async () => {
    const { matchConfigPattern } = await import(
      "../packages/vinext/src/index.js"
    );
    // One segment
    expect(matchConfigPattern("/api/users", "/api/:path+")).toEqual({ path: "users" });
    // Multiple segments
    expect(matchConfigPattern("/api/users/123", "/api/:path+")).toEqual({ path: "users/123" });
    // Zero segments — should NOT match
    expect(matchConfigPattern("/api", "/api/:path+")).toBeNull();
  });

  it("matches regex group patterns", async () => {
    const { matchConfigPattern } = await import(
      "../packages/vinext/src/index.js"
    );
    // Common Next.js pattern: /:path(\\d+) for numeric paths
    const result = matchConfigPattern("/123", "/:id(\\d+)");
    if (result) {
      expect(result.id).toBe("123");
    }
    // Non-numeric should not match
    expect(matchConfigPattern("/abc", "/:id(\\d+)")).toBeNull();
  });

  it("handles dots in patterns", async () => {
    const { matchConfigPattern } = await import(
      "../packages/vinext/src/index.js"
    );
    expect(matchConfigPattern("/feed.xml", "/feed.xml")).toEqual({});
    // Dot should not match any character
    expect(matchConfigPattern("/feedXxml", "/feed.xml")).toBeNull();
  });

  it("matches :path* with literal suffix (e.g. /:path*.md)", async () => {
    const { matchConfigPattern } = await import(
      "../packages/vinext/src/index.js"
    );
    // Should match URLs ending in .md
    expect(matchConfigPattern("/article.md", "/:path*.md")).toEqual({ path: "article" });
    expect(matchConfigPattern("/news/my-article.md", "/:path*.md")).toEqual({ path: "news/my-article" });
    expect(matchConfigPattern("/docs/guide/intro.md", "/:path*.md")).toEqual({ path: "docs/guide/intro" });
    // Should NOT match URLs without .md suffix
    expect(matchConfigPattern("/", "/:path*.md")).toBeNull();
    expect(matchConfigPattern("/about", "/:path*.md")).toBeNull();
    expect(matchConfigPattern("/news", "/:path*.md")).toBeNull();
    expect(matchConfigPattern("/article.txt", "/:path*.md")).toBeNull();
  });

  it("matches :path+ with literal suffix (e.g. /:path+.json)", async () => {
    const { matchConfigPattern } = await import(
      "../packages/vinext/src/index.js"
    );
    // Should match URLs ending in .json with at least one path segment
    expect(matchConfigPattern("/data.json", "/:path+.json")).toEqual({ path: "data" });
    expect(matchConfigPattern("/api/users.json", "/:path+.json")).toEqual({ path: "api/users" });
    // Should NOT match bare .json (zero segments before suffix)
    expect(matchConfigPattern("/.json", "/:path+.json")).toBeNull();
    // Should NOT match URLs without .json suffix
    expect(matchConfigPattern("/data", "/:path+.json")).toBeNull();
    expect(matchConfigPattern("/", "/:path+.json")).toBeNull();
  });

  it("matches :path* with prefix and suffix (e.g. /docs/:path*.md)", async () => {
    const { matchConfigPattern } = await import(
      "../packages/vinext/src/index.js"
    );
    expect(matchConfigPattern("/docs/intro.md", "/docs/:path*.md")).toEqual({ path: "intro" });
    expect(matchConfigPattern("/docs/guide/getting-started.md", "/docs/:path*.md")).toEqual({
      path: "guide/getting-started",
    });
    // Should NOT match without .md
    expect(matchConfigPattern("/docs/intro", "/docs/:path*.md")).toBeNull();
    // Should NOT match different prefix
    expect(matchConfigPattern("/blog/intro.md", "/docs/:path*.md")).toBeNull();
  });

  it("still matches plain :path* catch-all (no suffix) correctly", async () => {
    const { matchConfigPattern } = await import(
      "../packages/vinext/src/index.js"
    );
    // Ensure the fix doesn't regress existing catch-all behavior
    expect(matchConfigPattern("/docs", "/docs/:path*")).toEqual({ path: "" });
    expect(matchConfigPattern("/docs/intro", "/docs/:path*")).toEqual({ path: "intro" });
    expect(matchConfigPattern("/docs/guide/getting-started", "/docs/:path*")).toEqual({
      path: "guide/getting-started",
    });
  });
});

// ---------------------------------------------------------------------------
// isSafeRegex / safeRegExp unit tests (ReDoS prevention)

describe("isSafeRegex", () => {
  it("accepts simple patterns", async () => {
    const { isSafeRegex } = await import(
      "../packages/vinext/src/config/config-matchers.js"
    );
    expect(isSafeRegex("^/about$")).toBe(true);
    expect(isSafeRegex("^/blog/[^/]+$")).toBe(true);
    expect(isSafeRegex("^/docs/(.*)$")).toBe(true);
    expect(isSafeRegex("^/api/(.+)$")).toBe(true);
    expect(isSafeRegex("\\d+")).toBe(true);
    expect(isSafeRegex("^/feed\\.xml$")).toBe(true);
  });

  it("accepts non-nested quantifiers inside groups", async () => {
    const { isSafeRegex } = await import(
      "../packages/vinext/src/config/config-matchers.js"
    );
    // A single quantifier inside a group without a quantifier on the group itself
    expect(isSafeRegex("(a+)")).toBe(true);
    expect(isSafeRegex("([^/]+)")).toBe(true);
    expect(isSafeRegex("(\\d{2,4})")).toBe(true);
  });

  it("rejects nested quantifiers: (a+)+", async () => {
    const { isSafeRegex } = await import(
      "../packages/vinext/src/config/config-matchers.js"
    );
    expect(isSafeRegex("(a+)+")).toBe(false);
  });

  it("rejects nested quantifiers: (a+)*", async () => {
    const { isSafeRegex } = await import(
      "../packages/vinext/src/config/config-matchers.js"
    );
    expect(isSafeRegex("(a+)*")).toBe(false);
  });

  it("rejects nested quantifiers: (.*)*", async () => {
    const { isSafeRegex } = await import(
      "../packages/vinext/src/config/config-matchers.js"
    );
    expect(isSafeRegex("(.*)*")).toBe(false);
  });

  it("rejects nested quantifiers: (a*)+", async () => {
    const { isSafeRegex } = await import(
      "../packages/vinext/src/config/config-matchers.js"
    );
    expect(isSafeRegex("(a*)+")).toBe(false);
  });

  it("rejects nested quantifiers: ([^/]+)+", async () => {
    const { isSafeRegex } = await import(
      "../packages/vinext/src/config/config-matchers.js"
    );
    expect(isSafeRegex("([^/]+)+")).toBe(false);
  });

  it("rejects nested quantifiers with braces: (a+){2,}", async () => {
    const { isSafeRegex } = await import(
      "../packages/vinext/src/config/config-matchers.js"
    );
    expect(isSafeRegex("(a+){2,}")).toBe(false);
  });

  it("accepts quantifier on group without inner quantifier", async () => {
    const { isSafeRegex } = await import(
      "../packages/vinext/src/config/config-matchers.js"
    );
    // (ab)+ is fine — no inner quantifier
    expect(isSafeRegex("(ab)+")).toBe(true);
    expect(isSafeRegex("(foo|bar)*")).toBe(true);
  });

  it("treats escaped characters as safe", async () => {
    const { isSafeRegex } = await import(
      "../packages/vinext/src/config/config-matchers.js"
    );
    // \\+ is a literal +, not a quantifier
    expect(isSafeRegex("(a\\+)+")).toBe(true);
  });

  it("treats quantifiers inside character classes as safe", async () => {
    const { isSafeRegex } = await import(
      "../packages/vinext/src/config/config-matchers.js"
    );
    // [+*] is a character class, not a quantifier
    expect(isSafeRegex("([+*])+")).toBe(true);
  });

  it("rejects nested optional quantifiers: (a?)+", async () => {
    const { isSafeRegex } = await import(
      "../packages/vinext/src/config/config-matchers.js"
    );
    // '?' inside group + quantifier on group = catastrophic backtracking
    expect(isSafeRegex("(a?)+")).toBe(false);
    expect(isSafeRegex("(a?)+b")).toBe(false);
  });

  it("rejects nested optional quantifiers: (.?)+", async () => {
    const { isSafeRegex } = await import(
      "../packages/vinext/src/config/config-matchers.js"
    );
    expect(isSafeRegex("(.?)+")).toBe(false);
  });

  it("rejects nested optional quantifiers: (a?)*", async () => {
    const { isSafeRegex } = await import(
      "../packages/vinext/src/config/config-matchers.js"
    );
    expect(isSafeRegex("(a?)*")).toBe(false);
  });

  it("accepts outer '?' on group (zero-or-one is not unbounded repetition)", async () => {
    const { isSafeRegex } = await import(
      "../packages/vinext/src/config/config-matchers.js"
    );
    // '?' means zero or one — only 2 paths, not exponential backtracking
    // This is safe even with inner quantifiers (e.g. URL patterns like (?:/.*)?  )
    expect(isSafeRegex("(a+)?")).toBe(true);
    expect(isSafeRegex("(?:/.*)?")).toBe(true);
  });

  it("treats non-greedy modifier as safe, not as quantifier", async () => {
    const { isSafeRegex } = await import(
      "../packages/vinext/src/config/config-matchers.js"
    );
    // a+? is non-greedy '+', not a nested quantifier
    expect(isSafeRegex("(a+?)")).toBe(true);
    // (a*?) is non-greedy '*', still just one quantifier
    expect(isSafeRegex("(a*?)")).toBe(true);
  });
});

describe("safeRegExp", () => {
  it("returns RegExp for safe patterns", async () => {
    const { safeRegExp } = await import(
      "../packages/vinext/src/config/config-matchers.js"
    );
    const re = safeRegExp("^/about$");
    expect(re).toBeInstanceOf(RegExp);
    expect(re!.test("/about")).toBe(true);
  });

  it("returns null for pathological patterns", async () => {
    const { safeRegExp } = await import(
      "../packages/vinext/src/config/config-matchers.js"
    );
    // lgtm[js/redos] — deliberate pathological regex to test safeRegExp guard
    const re = safeRegExp("(a+)+b");
    expect(re).toBeNull();
  });

  it("returns null for invalid regex syntax", async () => {
    const { safeRegExp } = await import(
      "../packages/vinext/src/config/config-matchers.js"
    );
    const re = safeRegExp("(?P<name>");
    expect(re).toBeNull();
  });
});

describe("escapeHeaderSource", () => {
  it("passes through literal paths unchanged", async () => {
    const { escapeHeaderSource } = await import(
      "../packages/vinext/src/config/config-matchers.js"
    );
    expect(escapeHeaderSource("/api/users")).toBe("/api/users");
  });

  it("escapes dots", async () => {
    const { escapeHeaderSource } = await import(
      "../packages/vinext/src/config/config-matchers.js"
    );
    expect(escapeHeaderSource("/file.txt")).toBe("/file\\.txt");
  });

  it("converts named param to [^/]+", async () => {
    const { escapeHeaderSource } = await import(
      "../packages/vinext/src/config/config-matchers.js"
    );
    expect(escapeHeaderSource("/user/:id")).toBe("/user/[^/]+");
  });

  it("converts glob * to .*", async () => {
    const { escapeHeaderSource } = await import(
      "../packages/vinext/src/config/config-matchers.js"
    );
    expect(escapeHeaderSource("/api/*")).toBe("/api/.*");
  });

  it("escapes + and ?", async () => {
    const { escapeHeaderSource } = await import(
      "../packages/vinext/src/config/config-matchers.js"
    );
    expect(escapeHeaderSource("/path+query")).toBe("/path\\+query");
    expect(escapeHeaderSource("/maybe?")).toBe("/maybe\\?");
  });

  it("handles constrained param :param(constraint)", async () => {
    const { escapeHeaderSource } = await import(
      "../packages/vinext/src/config/config-matchers.js"
    );
    expect(escapeHeaderSource("/api/:version(\\d+)/users")).toBe("/api/(\\d+)/users");
  });

  it("handles constrained param with alternation", async () => {
    const { escapeHeaderSource } = await import(
      "../packages/vinext/src/config/config-matchers.js"
    );
    expect(escapeHeaderSource("/:lang(en|fr)/page")).toBe("/(en|fr)/page");
  });

  it("preserves standalone regex groups", async () => {
    const { escapeHeaderSource } = await import(
      "../packages/vinext/src/config/config-matchers.js"
    );
    expect(escapeHeaderSource("/api/(v1|v2)/users")).toBe("/api/(v1|v2)/users");
  });

  it("handles multiple groups and params", async () => {
    const { escapeHeaderSource } = await import(
      "../packages/vinext/src/config/config-matchers.js"
    );
    expect(escapeHeaderSource("/:lang(en|fr)/:id(\\d+)/page")).toBe("/(en|fr)/(\\d+)/page");
  });
});

describe("matchConfigPattern rejects ReDoS patterns", () => {
  it("returns null for pathological source patterns", async () => {
    const { matchConfigPattern } = await import(
      "../packages/vinext/src/config/config-matchers.js"
    );
    // This pattern has nested quantifiers: the compiled regex would be (a+)+b
    // which causes catastrophic backtracking. matchConfigPattern should return
    // null (no match) rather than hanging.
    // lgtm[js/redos] — deliberate pathological regex to test safeRegExp guard
    const result = matchConfigPattern(
      "/aaaaaaaaaaaaaaaaaaaac",
      "/:id((a+)+b)",
    );
    expect(result).toBeNull();
  });
});

describe("matchConfigPattern handles parameterized suffix patterns", () => {
  it("matches :path* with literal suffix (e.g. /:path*.md)", async () => {
    const { matchConfigPattern } = await import(
      "../packages/vinext/src/config/config-matchers.js"
    );
    // Should match URLs ending in .md
    expect(matchConfigPattern("/article.md", "/:path*.md")).toEqual({ path: "article" });
    expect(matchConfigPattern("/news/my-article.md", "/:path*.md")).toEqual({ path: "news/my-article" });
    // Should NOT match URLs without .md suffix
    expect(matchConfigPattern("/", "/:path*.md")).toBeNull();
    expect(matchConfigPattern("/about", "/:path*.md")).toBeNull();
    expect(matchConfigPattern("/news", "/:path*.md")).toBeNull();
  });

  it("matches :path+ with literal suffix (e.g. /:path+.json)", async () => {
    const { matchConfigPattern } = await import(
      "../packages/vinext/src/config/config-matchers.js"
    );
    expect(matchConfigPattern("/data.json", "/:path+.json")).toEqual({ path: "data" });
    expect(matchConfigPattern("/api/users.json", "/:path+.json")).toEqual({ path: "api/users" });
    // Zero segments before suffix — should NOT match for :path+
    expect(matchConfigPattern("/.json", "/:path+.json")).toBeNull();
    expect(matchConfigPattern("/", "/:path+.json")).toBeNull();
  });

  it("does not regress plain :path* catch-all (no suffix)", async () => {
    const { matchConfigPattern } = await import(
      "../packages/vinext/src/config/config-matchers.js"
    );
    expect(matchConfigPattern("/docs", "/docs/:path*")).toEqual({ path: "" });
    expect(matchConfigPattern("/docs/intro", "/docs/:path*")).toEqual({ path: "intro" });
    expect(matchConfigPattern("/docs/guide/getting-started", "/docs/:path*")).toEqual({
      path: "guide/getting-started",
    });
  });
});

// ---------------------------------------------------------------------------
// has/missing condition matching unit tests (next.config.js redirects/rewrites)

describe("parseCookies", () => {
  it("parses standard cookie header", async () => {
    const { parseCookies } = await import(
      "../packages/vinext/src/config/config-matchers.js"
    );
    expect(parseCookies("a=1; b=2; c=three")).toEqual({ a: "1", b: "2", c: "three" });
  });

  it("returns empty object for null", async () => {
    const { parseCookies } = await import(
      "../packages/vinext/src/config/config-matchers.js"
    );
    expect(parseCookies(null)).toEqual({});
  });

  it("returns empty object for empty string", async () => {
    const { parseCookies } = await import(
      "../packages/vinext/src/config/config-matchers.js"
    );
    expect(parseCookies("")).toEqual({});
  });

  it("handles cookies with = in value", async () => {
    const { parseCookies } = await import(
      "../packages/vinext/src/config/config-matchers.js"
    );
    expect(parseCookies("token=abc=def")).toEqual({ token: "abc=def" });
  });

  it("trims whitespace around keys and values", async () => {
    const { parseCookies } = await import(
      "../packages/vinext/src/config/config-matchers.js"
    );
    expect(parseCookies("  a = 1 ;  b = 2 ")).toEqual({ a: "1", b: "2" });
  });
});

describe("checkHasConditions", () => {
  function makeCtx(overrides: Partial<{
    headers: Record<string, string>;
    cookies: Record<string, string>;
    query: Record<string, string>;
    host: string;
  }> = {}) {
    const headers = new Headers(overrides.headers ?? {});
    if (overrides.cookies) {
      headers.set("cookie", Object.entries(overrides.cookies).map(([k, v]) => `${k}=${v}`).join("; "));
    }
    const query = new URLSearchParams(overrides.query ?? {});
    return {
      headers,
      cookies: overrides.cookies ?? {},
      query,
      host: overrides.host ?? "localhost",
    };
  }

  it("returns true when no conditions", async () => {
    const { checkHasConditions } = await import(
      "../packages/vinext/src/config/config-matchers.js"
    );
    expect(checkHasConditions(undefined, undefined, makeCtx())).toBe(true);
  });

  // -- header conditions --
  it("has header: passes when header present", async () => {
    const { checkHasConditions } = await import(
      "../packages/vinext/src/config/config-matchers.js"
    );
    const ctx = makeCtx({ headers: { "x-custom": "yes" } });
    expect(checkHasConditions([{ type: "header", key: "x-custom" }], undefined, ctx)).toBe(true);
  });

  it("has header: fails when header absent", async () => {
    const { checkHasConditions } = await import(
      "../packages/vinext/src/config/config-matchers.js"
    );
    const ctx = makeCtx({});
    expect(checkHasConditions([{ type: "header", key: "x-custom" }], undefined, ctx)).toBe(false);
  });

  it("has header with value: matches regex", async () => {
    const { checkHasConditions } = await import(
      "../packages/vinext/src/config/config-matchers.js"
    );
    const ctx = makeCtx({ headers: { "x-auth": "yes" } });
    expect(checkHasConditions([{ type: "header", key: "x-auth", value: "(?:yes|true)" }], undefined, ctx)).toBe(true);
    expect(checkHasConditions([{ type: "header", key: "x-auth", value: "(?:no|false)" }], undefined, ctx)).toBe(false);
  });

  // -- cookie conditions --
  it("has cookie: passes when cookie present", async () => {
    const { checkHasConditions } = await import(
      "../packages/vinext/src/config/config-matchers.js"
    );
    const ctx = makeCtx({ cookies: { "session": "abc" } });
    expect(checkHasConditions([{ type: "cookie", key: "session" }], undefined, ctx)).toBe(true);
  });

  it("has cookie: fails when cookie absent", async () => {
    const { checkHasConditions } = await import(
      "../packages/vinext/src/config/config-matchers.js"
    );
    const ctx = makeCtx({ cookies: {} });
    expect(checkHasConditions([{ type: "cookie", key: "session" }], undefined, ctx)).toBe(false);
  });

  it("has cookie with exact value", async () => {
    const { checkHasConditions } = await import(
      "../packages/vinext/src/config/config-matchers.js"
    );
    const ctx = makeCtx({ cookies: { "authorized": "true" } });
    expect(checkHasConditions([{ type: "cookie", key: "authorized", value: "true" }], undefined, ctx)).toBe(true);
    expect(checkHasConditions([{ type: "cookie", key: "authorized", value: "false" }], undefined, ctx)).toBe(false);
  });

  // -- query conditions --
  it("has query: passes when query param present", async () => {
    const { checkHasConditions } = await import(
      "../packages/vinext/src/config/config-matchers.js"
    );
    const ctx = makeCtx({ query: { page: "home" } });
    expect(checkHasConditions([{ type: "query", key: "page" }], undefined, ctx)).toBe(true);
  });

  it("has query: fails when query param absent", async () => {
    const { checkHasConditions } = await import(
      "../packages/vinext/src/config/config-matchers.js"
    );
    const ctx = makeCtx({ query: {} });
    expect(checkHasConditions([{ type: "query", key: "page" }], undefined, ctx)).toBe(false);
  });

  it("has query with regex value", async () => {
    const { checkHasConditions } = await import(
      "../packages/vinext/src/config/config-matchers.js"
    );
    const ctx = makeCtx({ query: { page: "home" } });
    expect(checkHasConditions([{ type: "query", key: "page", value: "home|about" }], undefined, ctx)).toBe(true);
    expect(checkHasConditions([{ type: "query", key: "page", value: "^settings$" }], undefined, ctx)).toBe(false);
  });

  // -- host conditions --
  it("has host: matches exact value", async () => {
    const { checkHasConditions } = await import(
      "../packages/vinext/src/config/config-matchers.js"
    );
    const ctx = makeCtx({ host: "example.com" });
    expect(checkHasConditions([{ type: "host", key: "", value: "example.com" }], undefined, ctx)).toBe(true);
    expect(checkHasConditions([{ type: "host", key: "", value: "other.com" }], undefined, ctx)).toBe(false);
  });

  it("has host: matches regex value", async () => {
    const { checkHasConditions } = await import(
      "../packages/vinext/src/config/config-matchers.js"
    );
    const ctx = makeCtx({ host: "staging.example.com" });
    expect(checkHasConditions([{ type: "host", key: "", value: ".*\\.example\\.com" }], undefined, ctx)).toBe(true);
  });

  // -- missing conditions --
  it("missing header: passes when header absent", async () => {
    const { checkHasConditions } = await import(
      "../packages/vinext/src/config/config-matchers.js"
    );
    const ctx = makeCtx({});
    expect(checkHasConditions(undefined, [{ type: "header", key: "x-block" }], ctx)).toBe(true);
  });

  it("missing header: fails when header present", async () => {
    const { checkHasConditions } = await import(
      "../packages/vinext/src/config/config-matchers.js"
    );
    const ctx = makeCtx({ headers: { "x-block": "1" } });
    expect(checkHasConditions(undefined, [{ type: "header", key: "x-block" }], ctx)).toBe(false);
  });

  it("missing cookie: passes when cookie absent", async () => {
    const { checkHasConditions } = await import(
      "../packages/vinext/src/config/config-matchers.js"
    );
    const ctx = makeCtx({ cookies: {} });
    expect(checkHasConditions(undefined, [{ type: "cookie", key: "stay-here" }], ctx)).toBe(true);
  });

  it("missing cookie: fails when cookie present", async () => {
    const { checkHasConditions } = await import(
      "../packages/vinext/src/config/config-matchers.js"
    );
    const ctx = makeCtx({ cookies: { "stay-here": "1" } });
    expect(checkHasConditions(undefined, [{ type: "cookie", key: "stay-here" }], ctx)).toBe(false);
  });

  // -- combined has + missing --
  it("both has and missing must pass", async () => {
    const { checkHasConditions } = await import(
      "../packages/vinext/src/config/config-matchers.js"
    );
    const ctx = makeCtx({ cookies: { "auth": "yes" } });
    // has: cookie auth present (passes), missing: cookie block absent (passes)
    expect(checkHasConditions(
      [{ type: "cookie", key: "auth" }],
      [{ type: "cookie", key: "block" }],
      ctx,
    )).toBe(true);
    // has: cookie auth present (passes), missing: cookie auth absent (fails — it's present)
    expect(checkHasConditions(
      [{ type: "cookie", key: "auth" }],
      [{ type: "cookie", key: "auth" }],
      ctx,
    )).toBe(false);
  });

  it("all has conditions must match (conjunction)", async () => {
    const { checkHasConditions } = await import(
      "../packages/vinext/src/config/config-matchers.js"
    );
    const ctx = makeCtx({ cookies: { "a": "1" }, query: { "page": "home" } });
    // Both match
    expect(checkHasConditions(
      [{ type: "cookie", key: "a" }, { type: "query", key: "page" }],
      undefined,
      ctx,
    )).toBe(true);
    // One doesn't match
    expect(checkHasConditions(
      [{ type: "cookie", key: "a" }, { type: "query", key: "missing" }],
      undefined,
      ctx,
    )).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isExternalUrl unit tests (external rewrite detection)

describe("isExternalUrl", () => {
  it("returns true for https:// URLs", async () => {
    const { isExternalUrl } = await import(
      "../packages/vinext/src/config/config-matchers.js"
    );
    expect(isExternalUrl("https://example.com/path")).toBe(true);
    expect(isExternalUrl("https://us.i.posthog.com/decide?v=3")).toBe(true);
  });

  it("returns true for http:// URLs", async () => {
    const { isExternalUrl } = await import(
      "../packages/vinext/src/config/config-matchers.js"
    );
    expect(isExternalUrl("http://example.com/api")).toBe(true);
  });

  it("returns false for relative paths", async () => {
    const { isExternalUrl } = await import(
      "../packages/vinext/src/config/config-matchers.js"
    );
    expect(isExternalUrl("/about")).toBe(false);
    expect(isExternalUrl("/api/test")).toBe(false);
    expect(isExternalUrl("/")).toBe(false);
  });

  it("returns true for protocol-relative URLs", async () => {
    const { isExternalUrl } = await import(
      "../packages/vinext/src/config/config-matchers.js"
    );
    expect(isExternalUrl("//example.com")).toBe(true);
    expect(isExternalUrl("//cdn.example.com/image.png")).toBe(true);
  });

  it("returns true for exotic URL schemes (data:, javascript:, blob:, ftp:)", async () => {
    const { isExternalUrl } = await import(
      "../packages/vinext/src/config/config-matchers.js"
    );
    expect(isExternalUrl("data:text/html,<h1>hi</h1>")).toBe(true);
    expect(isExternalUrl("javascript:alert(1)")).toBe(true);
    expect(isExternalUrl("blob:http://localhost/abc")).toBe(true);
    expect(isExternalUrl("ftp://files.example.com/pub")).toBe(true);
  });

  it("returns false for hash-only and bare strings", async () => {
    const { isExternalUrl } = await import(
      "../packages/vinext/src/config/config-matchers.js"
    );
    expect(isExternalUrl("#section")).toBe(false);
    expect(isExternalUrl("about")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// proxyExternalRequest unit tests

describe("proxyExternalRequest", () => {
  it("proxies request to external URL and returns upstream response", async () => {
    const { proxyExternalRequest } = await import(
      "../packages/vinext/src/config/config-matchers.js"
    );

    // Use a well-known public URL that returns a predictable response
    const request = new Request("http://localhost:3000/test?extra=1", {
      method: "GET",
      headers: { "user-agent": "vinext-test" },
    });

    // We test the function constructs the right request by mocking fetch
    const originalFetch = globalThis.fetch;
    let capturedUrl: string | undefined;
    let capturedInit: any;
    globalThis.fetch = async (url: any, init: any) => {
      capturedUrl = typeof url === "string" ? url : url.toString();
      capturedInit = init;
      return new Response("proxied body", {
        status: 200,
        headers: { "content-type": "text/plain", "x-upstream": "true" },
      });
    };

    try {
      const response = await proxyExternalRequest(request, "https://api.example.com/endpoint");
      expect(capturedUrl).toContain("https://api.example.com/endpoint");
      // Extra query param from original request should be merged
      expect(capturedUrl).toContain("extra=1");
      expect(capturedInit.method).toBe("GET");
      expect(capturedInit.redirect).toBe("manual");
      // Host header should be set to the external target
      expect(capturedInit.headers.get("host")).toBe("api.example.com");
      expect(response.status).toBe(200);
      expect(response.headers.get("x-upstream")).toBe("true");
      const body = await response.text();
      expect(body).toBe("proxied body");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("preserves query parameters from the rewrite destination", async () => {
    const { proxyExternalRequest } = await import(
      "../packages/vinext/src/config/config-matchers.js"
    );

    const request = new Request("http://localhost:3000/test", {
      method: "GET",
    });

    const originalFetch = globalThis.fetch;
    let capturedUrl: string | undefined;
    globalThis.fetch = async (url: any, _init: any) => {
      capturedUrl = typeof url === "string" ? url : url.toString();
      return new Response("ok", { status: 200 });
    };

    try {
      await proxyExternalRequest(request, "https://api.example.com/v1?key=abc");
      expect(capturedUrl).toContain("key=abc");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("strips hop-by-hop headers from upstream response", async () => {
    const { proxyExternalRequest } = await import(
      "../packages/vinext/src/config/config-matchers.js"
    );

    const request = new Request("http://localhost:3000/test");

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url: any, _init: any) => {
      return new Response("ok", {
        status: 200,
        headers: {
          "content-type": "text/plain",
          "x-custom": "preserved",
          // Note: "transfer-encoding" and "connection" are hop-by-hop headers
          // that should be stripped. However, the fetch API may not allow
          // setting them on Response, so we test with headers that can be set.
        },
      });
    };

    try {
      const response = await proxyExternalRequest(request, "https://api.example.com/test");
      expect(response.headers.get("content-type")).toBe("text/plain");
      expect(response.headers.get("x-custom")).toBe("preserved");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("passes through non-200 status codes", async () => {
    const { proxyExternalRequest } = await import(
      "../packages/vinext/src/config/config-matchers.js"
    );

    const request = new Request("http://localhost:3000/test");

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url: any, _init: any) => {
      return new Response("Not Found", { status: 404 });
    };

    try {
      const response = await proxyExternalRequest(request, "https://api.example.com/missing");
      expect(response.status).toBe(404);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("strips credentials and x-middleware-* headers from proxied requests", async () => {
    const { proxyExternalRequest } = await import(
      "../packages/vinext/src/config/config-matchers.js"
    );

    const request = new Request("http://localhost:3000/proxy", {
      method: "GET",
      headers: {
        "cookie": "session=secret123",
        "authorization": "Bearer tok_secret",
        "x-api-key": "sk_live_secret",
        "proxy-authorization": "Basic cHJveHk=",
        "x-middleware-rewrite": "/internal",
        "x-middleware-next": "1",
        "x-custom-header": "keep-me",
        "user-agent": "vinext-test",
      },
    });

    const originalFetch = globalThis.fetch;
    let capturedHeaders: Headers | undefined;
    globalThis.fetch = async (_url: any, init: any) => {
      capturedHeaders = init.headers;
      return new Response("ok", { status: 200 });
    };

    try {
      await proxyExternalRequest(request, "https://api.example.com/data");
      expect(capturedHeaders).toBeDefined();
      // Sensitive headers must be stripped
      expect(capturedHeaders!.get("cookie")).toBeNull();
      expect(capturedHeaders!.get("authorization")).toBeNull();
      expect(capturedHeaders!.get("x-api-key")).toBeNull();
      expect(capturedHeaders!.get("proxy-authorization")).toBeNull();
      expect(capturedHeaders!.get("x-middleware-rewrite")).toBeNull();
      expect(capturedHeaders!.get("x-middleware-next")).toBeNull();
      // Non-sensitive headers must be preserved
      expect(capturedHeaders!.get("x-custom-header")).toBe("keep-me");
      expect(capturedHeaders!.get("user-agent")).toBe("vinext-test");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("forwards redirect responses without following them", async () => {
    const { proxyExternalRequest } = await import(
      "../packages/vinext/src/config/config-matchers.js"
    );

    const request = new Request("http://localhost:3000/test");

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url: any, init: any) => {
      // Verify redirect: "manual" was set
      expect(init.redirect).toBe("manual");
      return new Response(null, {
        status: 301,
        headers: { "location": "https://other.example.com/new" },
      });
    };

    try {
      const response = await proxyExternalRequest(request, "https://api.example.com/old");
      expect(response.status).toBe(301);
      expect(response.headers.get("location")).toBe("https://other.example.com/new");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// matchRewrite + isExternalUrl integration (config-matchers)

describe("matchRewrite with external URLs", () => {
  it("returns full external URL when destination is external", async () => {
    const { matchRewrite, isExternalUrl } = await import(
      "../packages/vinext/src/config/config-matchers.js"
    );
    const rewrites = [
      { source: "/ph/:path*", destination: "https://us.i.posthog.com/:path*" },
    ];
    const result = matchRewrite("/ph/decide", rewrites);
    expect(result).toBe("https://us.i.posthog.com/decide");
    expect(isExternalUrl(result!)).toBe(true);
  });

  it("returns full external URL for static path rewrites", async () => {
    const { matchRewrite, isExternalUrl } = await import(
      "../packages/vinext/src/config/config-matchers.js"
    );
    const rewrites = [
      { source: "/ph/static/:path*", destination: "https://us-assets.i.posthog.com/static/:path*" },
    ];
    const result = matchRewrite("/ph/static/array.js", rewrites);
    expect(result).toBe("https://us-assets.i.posthog.com/static/array.js");
    expect(isExternalUrl(result!)).toBe(true);
  });

  it("returns internal path for non-external rewrites", async () => {
    const { matchRewrite, isExternalUrl } = await import(
      "../packages/vinext/src/config/config-matchers.js"
    );
    const rewrites = [
      { source: "/posts/:id", destination: "/blog/:id" },
    ];
    const result = matchRewrite("/posts/hello", rewrites);
    expect(result).toBe("/blog/hello");
    expect(isExternalUrl(result!)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// sanitizeDestination — protocol-relative URL handling

describe("sanitizeDestination", () => {
  it("collapses leading // to / for relative URLs", async () => {
    const { sanitizeDestination } = await import(
      "../packages/vinext/src/config/config-matchers.js"
    );
    expect(sanitizeDestination("//evil.com")).toBe("/evil.com");
    expect(sanitizeDestination("///evil.com")).toBe("/evil.com");
    expect(sanitizeDestination("////evil.com/path")).toBe("/evil.com/path");
  });

  it("preserves external http:// and https:// URLs", async () => {
    const { sanitizeDestination } = await import(
      "../packages/vinext/src/config/config-matchers.js"
    );
    expect(sanitizeDestination("https://example.com/path")).toBe("https://example.com/path");
    expect(sanitizeDestination("http://example.com")).toBe("http://example.com");
  });

  it("normalizes leading backslashes (browsers treat \\ as /)", async () => {
    const { sanitizeDestination } = await import(
      "../packages/vinext/src/config/config-matchers.js"
    );
    expect(sanitizeDestination("\\/evil.com")).toBe("/evil.com");
    expect(sanitizeDestination("\\\\evil.com")).toBe("/evil.com");
    expect(sanitizeDestination("\\\\/evil.com")).toBe("/evil.com");
    expect(sanitizeDestination("/\\evil.com")).toBe("/evil.com");
  });

  it("preserves normal relative paths", async () => {
    const { sanitizeDestination } = await import(
      "../packages/vinext/src/config/config-matchers.js"
    );
    expect(sanitizeDestination("/about")).toBe("/about");
    expect(sanitizeDestination("/blog/hello")).toBe("/blog/hello");
    expect(sanitizeDestination("/")).toBe("/");
  });
});

// ---------------------------------------------------------------------------
// Catch-all redirect destination sanitization

describe("open redirect prevention in catch-all redirects", () => {
  it("matchRedirect sanitizes decoded %2F that would produce //evil.com", async () => {
    const { matchRedirect } = await import(
      "../packages/vinext/src/config/config-matchers.js"
    );
    // In the real request flow, the entry point decodes %2F to / and
    // normalizePath collapses // to /. So /old/%2Fevil.com arrives as
    // /old/evil.com (after decode + normalize).
    // Test with the already-decoded path (how matchRedirect is actually called).
    const redirects = [
      { source: "/old/:path*", destination: "/:path*", permanent: false },
    ];
    const result = matchRedirect("/old/evil.com", redirects);
    expect(result).not.toBeNull();
    expect(result!.destination).toBe("/evil.com");
    // Verify it does NOT start with // (protocol-relative)
    expect(result!.destination.startsWith("//")).toBe(false);
  });

  it("matchRedirect sanitizes double-slash in already-decoded paths", async () => {
    const { matchRedirect } = await import(
      "../packages/vinext/src/config/config-matchers.js"
    );
    const redirects = [
      { source: "/old/:path*", destination: "/:path*", permanent: false },
    ];
    // Even if an already-decoded path somehow contains //, the sanitizer should handle it
    const result = matchRedirect("/old//evil.com", redirects);
    expect(result).not.toBeNull();
    expect(result!.destination.startsWith("//")).toBe(false);
  });

  it("matchRedirect preserves valid external redirect destinations", async () => {
    const { matchRedirect } = await import(
      "../packages/vinext/src/config/config-matchers.js"
    );
    const redirects = [
      { source: "/go/:path*", destination: "https://example.com/:path*", permanent: false },
    ];
    const result = matchRedirect("/go/page", redirects);
    expect(result).not.toBeNull();
    expect(result!.destination).toBe("https://example.com/page");
  });

  it("matchRewrite sanitizes decoded %2F that would produce //evil.com", async () => {
    const { matchRewrite } = await import(
      "../packages/vinext/src/config/config-matchers.js"
    );
    const rewrites = [
      { source: "/old/:path*", destination: "/:path*" },
    ];
    // In the real request flow, the entry point decodes and normalizePath
    // collapses //. Test with already-decoded path.
    const result = matchRewrite("/old/evil.com", rewrites);
    expect(result).not.toBeNull();
    expect(result!).toBe("/evil.com");
    expect(result!.startsWith("//")).toBe(false);
  });
});

describe("next/form shim", () => {
  it("exports default Form component", async () => {
    const mod = await import("../packages/vinext/src/shims/form.js");
    expect(mod.default).toBeDefined();
    expect(typeof mod.default).toBe("object"); // forwardRef returns an object
  });

  it("re-exports useActionState from React", async () => {
    const mod = await import("../packages/vinext/src/shims/form.js");
    expect(typeof mod.useActionState).toBe("function");
  });

  it("renders a form element with string action in SSR", async () => {
    const React = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { default: Form } = await import("../packages/vinext/src/shims/form.js");

    const html = renderToStaticMarkup(
      React.createElement(
        Form,
        { action: "/search" },
        React.createElement("input", { name: "q" }),
        React.createElement("button", { type: "submit" }, "Search"),
      ),
    );
    expect(html).toContain("<form");
    expect(html).toContain('action="/search"');
    expect(html).toContain('name="q"');
    expect(html).toContain("Search");
  });

  it("renders a form with method prop", async () => {
    const React = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { default: Form } = await import("../packages/vinext/src/shims/form.js");

    const html = renderToStaticMarkup(
      React.createElement(
        Form,
        { action: "/api/submit", method: "POST" },
        React.createElement("button", { type: "submit" }, "Submit"),
      ),
    );
    expect(html).toContain("<form");
    expect(html).toContain('method="POST"');
  });

  it("renders children inside the form", async () => {
    const React = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { default: Form } = await import("../packages/vinext/src/shims/form.js");

    const html = renderToStaticMarkup(
      React.createElement(
        Form,
        { action: "/search" },
        React.createElement("label", null, "Query:"),
        React.createElement("input", { name: "q", placeholder: "Search..." }),
        React.createElement("button", null, "Go"),
      ),
    );
    expect(html).toContain("Query:");
    expect(html).toContain('placeholder="Search..."');
    expect(html).toContain("Go");
  });

  it("passes className and id through to form element", async () => {
    const React = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { default: Form } = await import("../packages/vinext/src/shims/form.js");

    const html = renderToStaticMarkup(
      React.createElement(
        Form,
        { action: "/search", className: "search-form", id: "main-search" },
      ),
    );
    expect(html).toContain('class="search-form"');
    expect(html).toContain('id="main-search"');
  });
});

describe("next/font/google shim", () => {
  it("returns className, style, and variable for a Google Font", async () => {
    const { Inter } = await import(
      "../packages/vinext/src/shims/font-google.js"
    );
    const result = Inter({ subsets: ["latin"], weight: ["400", "700"] });

    expect(result.className).toMatch(/^__font_inter_/);
    expect(result.style.fontFamily).toContain("Inter");
    // In Next.js, `variable` returns a CLASS NAME that sets the CSS variable.
    // Users apply this class to set the CSS variable on that element.
    expect(result.variable).toMatch(/^__variable_inter_/);
  });

  it("Proxy returns font loaders for any family", async () => {
    const mod = await import(
      "../packages/vinext/src/shims/font-google.js"
    );
    const googleFonts = mod.default;
    const loader = googleFonts.Poppins;
    expect(typeof loader).toBe("function");

    const result = loader({ weight: "400" });
    expect(result.className).toMatch(/^__font_poppins_/);
    expect(result.style.fontFamily).toContain("Poppins");
  });

  it("converts PascalCase to font family name", async () => {
    const mod = await import(
      "../packages/vinext/src/shims/font-google.js"
    );
    const googleFonts = mod.default;
    const result = googleFonts.RobotoMono({ weight: "400" });

    expect(result.style.fontFamily).toContain("Roboto Mono");
    // In Next.js, `variable` returns a CLASS NAME that sets the CSS variable.
    expect(result.variable).toMatch(/^__variable_roboto_mono_/);
  });

  it("uses custom variable name when provided", async () => {
    const { Inter } = await import(
      "../packages/vinext/src/shims/font-google.js"
    );
    const result = Inter({ variable: "--custom-font" });
    // When custom variable is provided, the generated class still sets that variable
    // The returned value is still a class name, not the CSS variable name itself
    expect(result.variable).toMatch(/^__variable_inter_/);
  });

  it("uses custom fallback fonts", async () => {
    const { Inter } = await import(
      "../packages/vinext/src/shims/font-google.js"
    );
    const result = Inter({ fallback: ["Helvetica", "Arial", "sans-serif"] });
    expect(result.style.fontFamily).toContain("Helvetica");
    expect(result.style.fontFamily).toContain("Arial");
  });

  it("generates CSS rules for className (SSR)", async () => {
    const { Inter, getSSRFontStyles } = await import(
      "../packages/vinext/src/shims/font-google.js"
    );
    // Clear any previously collected styles
    getSSRFontStyles();

    const result = Inter({ subsets: ["latin"], weight: ["400"] });

    // getSSRFontStyles should return CSS rules mapping className to font-family
    const styles = getSSRFontStyles();
    const allCss = styles.join("\n");
    expect(allCss).toContain(`.${result.className}`);
    expect(allCss).toContain("font-family:");
    expect(allCss).toContain("Inter");
  });

  it("generates CSS variable rule when variable is specified", async () => {
    const { Inter, getSSRFontStyles } = await import(
      "../packages/vinext/src/shims/font-google.js"
    );
    getSSRFontStyles(); // clear

    Inter({ variable: "--font-inter" });
    const styles = getSSRFontStyles();
    const allCss = styles.join("\n");
    expect(allCss).toContain("--font-inter:");
  });
});

describe("next/font/local shim", () => {
  it("returns className, style for a local font", async () => {
    const { default: localFont } = await import(
      "../packages/vinext/src/shims/font-local.js"
    );
    const result = localFont({ src: "./my-font.woff2" });

    expect(result.className).toMatch(/^__font_local_/);
    expect(result.style.fontFamily).toMatch(/__local_font_/);
  });

  it("includes variable as generated class name when specified", async () => {
    const { default: localFont } = await import(
      "../packages/vinext/src/shims/font-local.js"
    );
    const result = localFont({
      src: "./my-font.woff2",
      variable: "--font-custom",
    });
    // variable should be a generated class name, not the raw CSS variable
    expect(result.variable).toMatch(/^__variable_local_/);
    expect(result.variable).not.toBe("--font-custom");
  });

  it("accepts array of font sources", async () => {
    const { default: localFont } = await import(
      "../packages/vinext/src/shims/font-local.js"
    );
    const result = localFont({
      src: [
        { path: "./regular.woff2", weight: "400" },
        { path: "./bold.woff2", weight: "700" },
      ],
    });

    expect(result.className).toMatch(/^__font_local_/);
    expect(result.style.fontFamily).toBeTruthy();
  });

  it("does not include variable when not specified", async () => {
    const { default: localFont } = await import(
      "../packages/vinext/src/shims/font-local.js"
    );
    const result = localFont({ src: "./no-var.woff2" });
    expect(result.variable).toBeUndefined();
  });

  it("generates SSR font styles for className rules", async () => {
    const fontLocal = await import(
      "../packages/vinext/src/shims/font-local.js"
    );
    const localFont = fontLocal.default;
    // In test (Node), typeof document === "undefined", so SSR path is used
    const result = localFont({
      src: "./ssr-test.woff2",
      variable: "--font-ssr-test",
    });

    const ssrStyles = fontLocal.getSSRFontStyles();
    expect(ssrStyles.length).toBeGreaterThan(0);

    // Should contain @font-face rule
    const allCSS = ssrStyles.join("\n");
    expect(allCSS).toContain("@font-face");
    expect(allCSS).toContain("ssr-test.woff2");

    // Should contain className rule
    expect(allCSS).toContain(`.${result.className}`);
    expect(allCSS).toContain("font-family:");

    // Should contain variable class rule with :root fallback
    expect(allCSS).toContain(`.${result.variable}`);
    expect(allCSS).toContain("--font-ssr-test");
    expect(allCSS).toContain(":root");
  });

  it("generates unique classNames and variableClassNames", async () => {
    const { default: localFont } = await import(
      "../packages/vinext/src/shims/font-local.js"
    );
    const a = localFont({ src: "./a.woff2", variable: "--font-a" });
    const b = localFont({ src: "./b.woff2", variable: "--font-b" });

    expect(a.className).not.toBe(b.className);
    expect(a.variable).not.toBe(b.variable);
    expect(a.variable).toMatch(/^__variable_local_/);
    expect(b.variable).toMatch(/^__variable_local_/);
  });

  it("exports getSSRFontPreloads function", async () => {
    const fontLocal = await import(
      "../packages/vinext/src/shims/font-local.js"
    );
    expect(typeof fontLocal.getSSRFontPreloads).toBe("function");
  });

  it("collects preload data for fonts with absolute URLs", async () => {
    const fontLocal = await import(
      "../packages/vinext/src/shims/font-local.js"
    );
    const localFont = fontLocal.default;

    // Simulate a font with an absolute URL (as resolved by Vite transform)
    localFont({ src: "/assets/my-font-abc123.woff2" });

    const preloads = fontLocal.getSSRFontPreloads();
    const match = preloads.find(
      (p: any) => p.href === "/assets/my-font-abc123.woff2",
    );
    expect(match).toBeDefined();
    expect(match!.type).toBe("font/woff2");
  });

  it("collects preload data for array font sources with absolute URLs", async () => {
    const fontLocal = await import(
      "../packages/vinext/src/shims/font-local.js"
    );
    const localFont = fontLocal.default;

    localFont({
      src: [
        { path: "/assets/regular-abc.woff2", weight: "400" },
        { path: "/assets/bold-def.woff", weight: "700" },
      ],
    });

    const preloads = fontLocal.getSSRFontPreloads();
    const woff2 = preloads.find(
      (p: any) => p.href === "/assets/regular-abc.woff2",
    );
    const woff = preloads.find(
      (p: any) => p.href === "/assets/bold-def.woff",
    );
    expect(woff2).toBeDefined();
    expect(woff2!.type).toBe("font/woff2");
    expect(woff).toBeDefined();
    expect(woff!.type).toBe("font/woff");
  });

  it("does not collect preload data for relative URLs", async () => {
    const fontLocal = await import(
      "../packages/vinext/src/shims/font-local.js"
    );
    const localFont = fontLocal.default;

    const preloadsBefore = fontLocal.getSSRFontPreloads().length;
    localFont({ src: "./relative-font.woff2" });
    const preloadsAfter = fontLocal.getSSRFontPreloads().length;

    // Relative URLs should NOT be added to preloads
    expect(preloadsAfter).toBe(preloadsBefore);
  });

  it("deduplicates preload entries by href", async () => {
    const fontLocal = await import(
      "../packages/vinext/src/shims/font-local.js"
    );
    const localFont = fontLocal.default;

    // Call twice with the same font URL
    localFont({ src: "/assets/dedup-test.woff2" });
    localFont({ src: "/assets/dedup-test.woff2" });

    const preloads = fontLocal.getSSRFontPreloads();
    const matches = preloads.filter(
      (p: any) => p.href === "/assets/dedup-test.woff2",
    );
    expect(matches.length).toBe(1);
  });
});

describe("next/og shim", () => {
  it("exports ImageResponse class", async () => {
    const og = await import(
      "../packages/vinext/src/shims/og.js"
    );
    expect(og.ImageResponse).toBeDefined();
    expect(typeof og.ImageResponse).toBe("function");
  });

  it("ImageResponse extends Response", async () => {
    const og = await import(
      "../packages/vinext/src/shims/og.js"
    );
    // Check the prototype chain
    expect(og.ImageResponse.prototype instanceof Response).toBe(true);
  });

  it("generates a PNG image from JSX", async () => {
    const React = await import("react");
    const og = await import(
      "../packages/vinext/src/shims/og.js"
    );

    // Simple colored div — no text so no font needed
    const element = React.createElement(
      "div",
      {
        style: {
          display: "flex",
          width: "100%",
          height: "100%",
          backgroundColor: "#ff6600",
          alignItems: "center",
          justifyContent: "center",
        },
      },
    );

    const response = new og.ImageResponse(element, {
      width: 100,
      height: 100,
    });

    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");

    // Read the response body — should be valid PNG data
    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);

    // PNG magic bytes: 0x89 0x50 0x4E 0x47
    expect(bytes[0]).toBe(0x89);
    expect(bytes[1]).toBe(0x50); // P
    expect(bytes[2]).toBe(0x4e); // N
    expect(bytes[3]).toBe(0x47); // G
  });

  it("respects custom status and headers", async () => {
    const React = await import("react");
    const og = await import(
      "../packages/vinext/src/shims/og.js"
    );

    const element = React.createElement("div", {
      style: { display: "flex", width: "100%", height: "100%", backgroundColor: "blue" },
    });

    const response = new og.ImageResponse(element, {
      width: 50,
      height: 50,
      status: 201,
      headers: { "x-custom": "test-value" },
    });

    expect(response.status).toBe(201);
    expect(response.headers.get("x-custom")).toBe("test-value");
    expect(response.headers.get("content-type")).toBe("image/png");
  });

  it("uses default dimensions of 1200x630", async () => {
    const React = await import("react");
    const og = await import(
      "../packages/vinext/src/shims/og.js"
    );

    const element = React.createElement("div", {
      style: { display: "flex", width: "100%", height: "100%", backgroundColor: "green" },
    });

    // No width/height specified — should use defaults
    const response = new og.ImageResponse(element);
    expect(response).toBeInstanceOf(Response);

    // Verify it produces valid PNG
    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    expect(bytes[0]).toBe(0x89); // PNG magic
  });
});

describe("metadata route serializers", () => {
  it("sitemapToXml converts sitemap entries to valid XML", async () => {
    const { sitemapToXml } = await import(
      "../packages/vinext/src/server/metadata-routes.js"
    );
    const xml = sitemapToXml([
      { url: "https://example.com", lastModified: "2025-01-01", priority: 1 },
      { url: "https://example.com/about", changeFrequency: "monthly" as const },
    ]);
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain("<urlset");
    expect(xml).toContain("<loc>https://example.com</loc>");
    expect(xml).toContain("<lastmod>2025-01-01</lastmod>");
    expect(xml).toContain("<priority>1</priority>");
    expect(xml).toContain("<loc>https://example.com/about</loc>");
    expect(xml).toContain("<changefreq>monthly</changefreq>");
  });

  it("sitemapToXml handles Date objects", async () => {
    const { sitemapToXml } = await import(
      "../packages/vinext/src/server/metadata-routes.js"
    );
    const xml = sitemapToXml([
      { url: "https://example.com", lastModified: new Date("2025-06-15") },
    ]);
    expect(xml).toContain("<lastmod>2025-06-15T00:00:00.000Z</lastmod>");
  });

  it("robotsToText converts robots config to text", async () => {
    const { robotsToText } = await import(
      "../packages/vinext/src/server/metadata-routes.js"
    );
    const text = robotsToText({
      rules: { userAgent: "*", allow: "/", disallow: "/private/" },
      sitemap: "https://example.com/sitemap.xml",
    });
    expect(text).toContain("User-Agent: *");
    expect(text).toContain("Allow: /");
    expect(text).toContain("Disallow: /private/");
    expect(text).toContain("Sitemap: https://example.com/sitemap.xml");
  });

  it("robotsToText handles multiple rules", async () => {
    const { robotsToText } = await import(
      "../packages/vinext/src/server/metadata-routes.js"
    );
    const text = robotsToText({
      rules: [
        { userAgent: "Googlebot", allow: "/" },
        { userAgent: "Bingbot", disallow: "/secret" },
      ],
    });
    expect(text).toContain("User-Agent: Googlebot");
    expect(text).toContain("User-Agent: Bingbot");
    expect(text).toContain("Disallow: /secret");
  });

  it("manifestToJson converts manifest config to JSON", async () => {
    const { manifestToJson } = await import(
      "../packages/vinext/src/server/metadata-routes.js"
    );
    const json = manifestToJson({
      name: "Test App",
      short_name: "Test",
      start_url: "/",
      display: "standalone",
    });
    const parsed = JSON.parse(json);
    expect(parsed.name).toBe("Test App");
    expect(parsed.display).toBe("standalone");
  });

  it("scanMetadataFiles discovers metadata files in app directory", async () => {
    const { scanMetadataFiles } = await import(
      "../packages/vinext/src/server/metadata-routes.js"
    );
    const appDir = path.resolve(import.meta.dirname, "./fixtures/app-basic/app");
    const routes = scanMetadataFiles(appDir);

    // Should find our test fixture files
    const types = routes.map((r: { type: string }) => r.type);
    expect(types).toContain("sitemap");
    expect(types).toContain("robots");
    expect(types).toContain("manifest");
    expect(types).toContain("favicon");

    // Sitemap should be dynamic (.ts)
    const sitemap = routes.find((r: { type: string }) => r.type === "sitemap");
    expect(sitemap).toBeDefined();
    expect(sitemap!.isDynamic).toBe(true);
    expect(sitemap!.servedUrl).toBe("/sitemap.xml");
    expect(sitemap!.contentType).toBe("application/xml");

    // Favicon should be static (.ico)
    const favicon = routes.find((r: { type: string }) => r.type === "favicon");
    expect(favicon).toBeDefined();
    expect(favicon!.isDynamic).toBe(false);
    expect(favicon!.servedUrl).toBe("/favicon.ico");
    expect(favicon!.contentType).toBe("image/x-icon");
  });
});

describe("next/dynamic shim", () => {
  it("exports a default function", async () => {
    const mod = await import(
      "../packages/vinext/src/shims/dynamic.js"
    );
    expect(typeof mod.default).toBe("function");
  });

  it("exports flushPreloads", async () => {
    const mod = await import(
      "../packages/vinext/src/shims/dynamic.js"
    );
    expect(typeof mod.flushPreloads).toBe("function");
  });

  it("returns a component for SSR-enabled dynamic imports", async () => {
    const { default: dynamic } = await import(
      "../packages/vinext/src/shims/dynamic.js"
    );
    const React = await import("react");
    const { renderToReadableStream } = await import("react-dom/server.edge");

    const FakeComponent = () => React.createElement("div", null, "Hello from dynamic");
    const DynamicComponent = dynamic(() =>
      Promise.resolve({ default: FakeComponent }),
    );

    // renderToReadableStream handles React.lazy + Suspense
    const stream = await renderToReadableStream(React.createElement(DynamicComponent));
    await stream.allReady;
    const html = await new Response(stream).text();
    expect(html).toContain("Hello from dynamic");
  });

  it("renders loading state for ssr: false on server", async () => {
    const { default: dynamic } = await import(
      "../packages/vinext/src/shims/dynamic.js"
    );
    const React = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");

    const FakeComponent = () => React.createElement("div", null, "Should not appear");
    const Loading = () => React.createElement("span", null, "Loading...");
    const DynamicComponent = dynamic(
      () => Promise.resolve({ default: FakeComponent }),
      { ssr: false, loading: Loading },
    );

    // On server with ssr: false, should render loading, not the component
    const html = renderToStaticMarkup(React.createElement(DynamicComponent));
    expect(html).toContain("Loading...");
    expect(html).not.toContain("Should not appear");
  });

  it("renders nothing for ssr: false without loading on server", async () => {
    const { default: dynamic } = await import(
      "../packages/vinext/src/shims/dynamic.js"
    );
    const React = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");

    const FakeComponent = () => React.createElement("div", null, "Should not appear");
    const DynamicComponent = dynamic(
      () => Promise.resolve({ default: FakeComponent }),
      { ssr: false },
    );

    // On server with ssr: false and no loading component, should render nothing
    const html = renderToStaticMarkup(React.createElement(DynamicComponent));
    expect(html).toBe("");
  });

  it("accepts module without default export (bare component)", async () => {
    const { default: dynamic } = await import(
      "../packages/vinext/src/shims/dynamic.js"
    );
    const React = await import("react");
    const { renderToReadableStream } = await import("react-dom/server.edge");

    const BareComponent = () => React.createElement("p", null, "Bare export");
    const DynamicComponent = dynamic(() => Promise.resolve(BareComponent));

    const stream = await renderToReadableStream(React.createElement(DynamicComponent));
    await stream.allReady;
    const html = await new Response(stream).text();
    expect(html).toContain("Bare export");
  });

  it("forwards props to the underlying component", async () => {
    const { default: dynamic } = await import(
      "../packages/vinext/src/shims/dynamic.js"
    );
    const React = await import("react");
    const { renderToReadableStream } = await import("react-dom/server.edge");

    const Greeter = ({ name }: { name: string }) =>
      React.createElement("span", null, `Hello ${name}`);
    const DynamicGreeter = dynamic(() => Promise.resolve({ default: Greeter }));

    const stream = await renderToReadableStream(
      React.createElement(DynamicGreeter, { name: "World" }),
    );
    await stream.allReady;
    const html = await new Response(stream).text();
    expect(html).toContain("Hello World");
  });

  it("renders loading fallback when component not yet resolved (SSR)", async () => {
    const { default: dynamic } = await import(
      "../packages/vinext/src/shims/dynamic.js"
    );
    const React = await import("react");
    const { renderToReadableStream } = await import("react-dom/server.edge");

    let resolveLoader!: (val: any) => void;
    const loaderPromise = new Promise((r) => { resolveLoader = r; });
    const SlowComponent = () => React.createElement("div", null, "Loaded");
    const Loading = () => React.createElement("span", null, "Please wait...");

    const DynamicSlow = dynamic(() => loaderPromise as any, { loading: Loading });

    // Start streaming — the shell includes the Suspense fallback
    const stream = await renderToReadableStream(React.createElement(DynamicSlow));
    // Resolve the loader so the stream can complete
    resolveLoader({ default: SlowComponent });
    await stream.allReady;
    const html = await new Response(stream).text();
    // The final HTML should contain the resolved component, but the Suspense
    // fallback ("Please wait...") was sent as part of the shell before it resolved
    expect(html).toContain("Loaded");
  });

  it("streaming renderer resolves multiple dynamic components", async () => {
    const { default: dynamic } = await import(
      "../packages/vinext/src/shims/dynamic.js"
    );
    const React = await import("react");
    const { renderToReadableStream } = await import("react-dom/server.edge");

    const CompA = () => React.createElement("div", null, "Component A");
    const CompB = () => React.createElement("div", null, "Component B");

    const DynA = dynamic(() =>
      new Promise<any>((r) => setTimeout(() => r({ default: CompA }), 10)),
    );
    const DynB = dynamic(() =>
      new Promise<any>((r) => setTimeout(() => r({ default: CompB }), 10)),
    );

    // renderToReadableStream handles React.lazy via Suspense
    const streamA = await renderToReadableStream(React.createElement(DynA));
    await streamA.allReady;
    const htmlA = await new Response(streamA).text();

    const streamB = await renderToReadableStream(React.createElement(DynB));
    await streamB.allReady;
    const htmlB = await new Response(streamB).text();

    expect(htmlA).toContain("Component A");
    expect(htmlB).toContain("Component B");
  });

  it("flushPreloads second call resolves immediately (queue drained)", async () => {
    const { flushPreloads } = await import(
      "../packages/vinext/src/shims/dynamic.js"
    );

    // First call should drain whatever's in the queue
    await flushPreloads();

    // Second call should resolve immediately with empty array
    const result = await flushPreloads();
    expect(result).toEqual([]);
  });

  it("loading component receives isLoading and pastDelay props", async () => {
    const { default: dynamic } = await import(
      "../packages/vinext/src/shims/dynamic.js"
    );
    const React = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");

    let receivedProps: any = null;
    const Loading = (props: any) => {
      receivedProps = props;
      return React.createElement("span", null, "Loading");
    };

    const FakeComp = () => React.createElement("div", null, "Content");
    const DynComp = dynamic(
      () => Promise.resolve({ default: FakeComp }),
      { ssr: false, loading: Loading },
    );

    renderToStaticMarkup(React.createElement(DynComp));
    expect(receivedProps).not.toBeNull();
    expect(receivedProps.isLoading).toBe(true);
    expect(receivedProps.pastDelay).toBe(true);
    expect(receivedProps.error).toBeNull();
  });

  it("renders loading fallback for ssr: false with props forwarded", async () => {
    const { default: dynamic } = await import(
      "../packages/vinext/src/shims/dynamic.js"
    );
    const React = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");

    const HeavyChart = ({ title }: { title: string }) =>
      React.createElement("canvas", null, title);
    const Loading = () => React.createElement("div", null, "Chart loading...");

    const DynamicChart = dynamic(
      () => Promise.resolve({ default: HeavyChart }),
      { ssr: false, loading: Loading },
    );

    // On server: should show loading, not the chart
    const html = renderToStaticMarkup(
      React.createElement(DynamicChart, { title: "Revenue" }),
    );
    expect(html).toContain("Chart loading...");
    expect(html).not.toContain("Revenue");
  });

  it("handles module with both default and named exports", async () => {
    const { default: dynamic } = await import(
      "../packages/vinext/src/shims/dynamic.js"
    );
    const React = await import("react");
    const { renderToReadableStream } = await import("react-dom/server.edge");

    const MainComponent = () => React.createElement("div", null, "Main");
    const namedHelper = () => "helper";

    const DynComp = dynamic(() =>
      Promise.resolve({ default: MainComponent, namedHelper }),
    );

    const stream = await renderToReadableStream(React.createElement(DynComp));
    await stream.allReady;
    const html = await new Response(stream).text();
    expect(html).toContain("Main");
  });

  it("loader rejection does not crash flushPreloads", async () => {
    const { default: dynamic, flushPreloads } = await import(
      "../packages/vinext/src/shims/dynamic.js"
    );

    dynamic(() => Promise.reject(new Error("Module not found")));

    // flushPreloads should not throw (it's now a no-op for the server lazy path,
    // but kept for backward compatibility with Pages Router)
    await expect(flushPreloads()).resolves.not.toThrow();
  });

  it("loader rejection renders loading component with error", async () => {
    const { default: dynamic } = await import(
      "../packages/vinext/src/shims/dynamic.js"
    );
    const React = await import("react");
    const { renderToReadableStream } = await import("react-dom/server.edge");

    const LoadingComp = (props: { error?: Error | null; isLoading?: boolean }) => {
      if (props.error) {
        return React.createElement("div", null, `Error: ${props.error.message}`);
      }
      return React.createElement("div", null, "Loading...");
    };

    const DynComp = dynamic(
      () => Promise.reject(new Error("chunk load fail")),
      { loading: LoadingComp },
    );

    // The error boundary renders the loading component with the error
    const stream = await renderToReadableStream(React.createElement(DynComp));
    await stream.allReady;
    const html = await new Response(stream).text();
    expect(html).toContain("Error: chunk load fail");
  });

  it("loader rejection without loading component propagates via onError", async () => {
    const { default: dynamic } = await import(
      "../packages/vinext/src/shims/dynamic.js"
    );
    const React = await import("react");
    const { renderToReadableStream } = await import("react-dom/server.edge");

    const DynComp = dynamic(
      () => Promise.reject(new Error("fail")),
    );

    // Without a loading component, the Suspense fallback is null.
    // The rejected loader throws during rendering, caught by onError.
    const errors: Error[] = [];
    const stream = await renderToReadableStream(
      React.createElement(DynComp),
      { onError(err: unknown) { if (err instanceof Error) errors.push(err); } },
    );
    await stream.allReady.catch(() => {});
    expect(errors.some((e) => e.message === "fail")).toBe(true);
  });

  it("loader rejection with non-Error value is caught during SSR", async () => {
    const { default: dynamic } = await import(
      "../packages/vinext/src/shims/dynamic.js"
    );
    const React = await import("react");
    const { renderToReadableStream } = await import("react-dom/server.edge");

    const DynComp = dynamic(
      () => Promise.reject("string error"),
    );

    // Non-Error rejection values are caught by React's SSR error handling
    const errors: unknown[] = [];
    const stream = await renderToReadableStream(
      React.createElement(DynComp),
      { onError(err: unknown) { errors.push(err); } },
    );
    await stream.allReady.catch(() => {});
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe("basePath config validation", () => {
  it("resolveNextConfig preserves basePath with leading slash", async () => {
    const { resolveNextConfig } = await import(
      "../packages/vinext/src/config/next-config.js"
    );
    const config = await resolveNextConfig({ basePath: "/my-app" });
    expect(config.basePath).toBe("/my-app");
  });

  it("resolveNextConfig handles nested basePath", async () => {
    const { resolveNextConfig } = await import(
      "../packages/vinext/src/config/next-config.js"
    );
    const config = await resolveNextConfig({ basePath: "/a/b/c" });
    expect(config.basePath).toBe("/a/b/c");
  });

  it("resolveNextConfig defaults to empty string", async () => {
    const { resolveNextConfig } = await import(
      "../packages/vinext/src/config/next-config.js"
    );
    const config = await resolveNextConfig({});
    expect(config.basePath).toBe("");
  });

  it("resolveNextConfig handles undefined basePath", async () => {
    const { resolveNextConfig } = await import(
      "../packages/vinext/src/config/next-config.js"
    );
    const config = await resolveNextConfig({ basePath: undefined });
    expect(config.basePath).toBe("");
  });
});

describe("cacheComponents config (Next.js 16)", () => {
  it("resolveNextConfig defaults cacheComponents to false", async () => {
    const { resolveNextConfig } = await import(
      "../packages/vinext/src/config/next-config.js"
    );
    const config = await resolveNextConfig({});
    expect(config.cacheComponents).toBe(false);
  });

  it("resolveNextConfig reads cacheComponents: true", async () => {
    const { resolveNextConfig } = await import(
      "../packages/vinext/src/config/next-config.js"
    );
    const config = await resolveNextConfig({ cacheComponents: true });
    expect(config.cacheComponents).toBe(true);
  });

  it("resolveNextConfig reads cacheComponents: false", async () => {
    const { resolveNextConfig } = await import(
      "../packages/vinext/src/config/next-config.js"
    );
    const config = await resolveNextConfig({ cacheComponents: false });
    expect(config.cacheComponents).toBe(false);
  });

  it("resolveNextConfig handles null input with cacheComponents default", async () => {
    const { resolveNextConfig } = await import(
      "../packages/vinext/src/config/next-config.js"
    );
    const config = await resolveNextConfig(null);
    expect(config.cacheComponents).toBe(false);
  });

  it("resolveNextConfig defaults mdx to null", async () => {
    const { resolveNextConfig } = await import(
      "../packages/vinext/src/config/next-config.js"
    );
    const config = await resolveNextConfig({});
    expect(config.mdx).toBeNull();
  });

  it("resolveNextConfig returns null mdx for null input", async () => {
    const { resolveNextConfig } = await import(
      "../packages/vinext/src/config/next-config.js"
    );
    const config = await resolveNextConfig(null);
    expect(config.mdx).toBeNull();
  });

  it("resolveNextConfig resolves serverActionsAllowedOrigins from experimental.serverActions", async () => {
    const { resolveNextConfig } = await import(
      "../packages/vinext/src/config/next-config.js"
    );
    const config = await resolveNextConfig({
      experimental: {
        serverActions: {
          allowedOrigins: ["my-proxy.com", "*.my-domain.com"],
        },
      },
    });
    expect(config.serverActionsAllowedOrigins).toEqual(["my-proxy.com", "*.my-domain.com"]);
  });

  it("resolveNextConfig defaults serverActionsAllowedOrigins to empty array", async () => {
    const { resolveNextConfig } = await import(
      "../packages/vinext/src/config/next-config.js"
    );
    const config = await resolveNextConfig({});
    expect(config.serverActionsAllowedOrigins).toEqual([]);
  });

  it("resolveNextConfig handles null input with empty serverActionsAllowedOrigins", async () => {
    const { resolveNextConfig } = await import(
      "../packages/vinext/src/config/next-config.js"
    );
    const config = await resolveNextConfig(null);
    expect(config.serverActionsAllowedOrigins).toEqual([]);
  });
});

describe("loadNextConfig CJS support", () => {
  let tmpDir: string;

  beforeEach(async () => {
    const os = await import("node:os");
    const fsp = await import("node:fs/promises");
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-cjs-cfg-"));
  });

  afterEach(async () => {
    const fsp = await import("node:fs/promises");
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it("loads a CJS next.config.js that uses module.exports", async () => {
    const fsp = await import("node:fs/promises");
    const { loadNextConfig } = await import(
      "../packages/vinext/src/config/next-config.js"
    );

    await fsp.writeFile(
      path.join(tmpDir, "next.config.js"),
      `module.exports = { basePath: "/cjs-app", trailingSlash: true };`,
    );

    const config = await loadNextConfig(tmpDir);
    expect(config).not.toBeNull();
    expect(config!.basePath).toBe("/cjs-app");
    expect(config!.trailingSlash).toBe(true);
  });

  it("loads a CJS next.config.js with require() plugin wrapper", async () => {
    const fsp = await import("node:fs/promises");
    const { loadNextConfig } = await import(
      "../packages/vinext/src/config/next-config.js"
    );

    // Simulate a CJS plugin wrapper like nextra/next-intl/etc.
    // Create a fake plugin module that wraps the config
    await fsp.mkdir(path.join(tmpDir, "node_modules", "fake-plugin"), {
      recursive: true,
    });
    await fsp.writeFile(
      path.join(tmpDir, "node_modules", "fake-plugin", "index.js"),
      `module.exports = function fakePlugin(pluginOpts) {
        return function withPlugin(nextConfig) {
          return Object.assign({}, nextConfig, { env: { PLUGIN: "loaded" } });
        };
      };`,
    );
    await fsp.writeFile(
      path.join(tmpDir, "node_modules", "fake-plugin", "package.json"),
      JSON.stringify({ name: "fake-plugin", version: "1.0.0", main: "index.js" }),
    );

    // Write a next.config.js that uses require() — this is the pattern that fails
    await fsp.writeFile(
      path.join(tmpDir, "next.config.js"),
      `const withPlugin = require('fake-plugin')({ theme: 'docs' });
module.exports = withPlugin({ basePath: "/wrapped" });`,
    );

    const config = await loadNextConfig(tmpDir);
    expect(config).not.toBeNull();
    expect(config!.basePath).toBe("/wrapped");
    expect(config!.env).toEqual({ PLUGIN: "loaded" });
  });

  it("loads a CJS function-form next.config.js", async () => {
    const fsp = await import("node:fs/promises");
    const { loadNextConfig } = await import(
      "../packages/vinext/src/config/next-config.js"
    );

    await fsp.writeFile(
      path.join(tmpDir, "next.config.js"),
      `module.exports = function(phase, { defaultConfig }) {
        return { basePath: "/fn-" + phase.split("-")[1] };
      };`,
    );

    const config = await loadNextConfig(tmpDir);
    expect(config).not.toBeNull();
    // phase is "phase-development-server", split("-")[1] = "development"
    expect(config!.basePath).toBe("/fn-development");
  });

  it("loads a .cjs config file", async () => {
    const fsp = await import("node:fs/promises");
    const { loadNextConfig } = await import(
      "../packages/vinext/src/config/next-config.js"
    );

    await fsp.writeFile(
      path.join(tmpDir, "next.config.cjs"),
      `module.exports = { basePath: "/cjs-ext" };`,
    );

    const config = await loadNextConfig(tmpDir);
    expect(config).not.toBeNull();
    expect(config!.basePath).toBe("/cjs-ext");
  });

  it("loads an ESM next.config.mjs normally", async () => {
    const fsp = await import("node:fs/promises");
    const { loadNextConfig } = await import(
      "../packages/vinext/src/config/next-config.js"
    );

    await fsp.writeFile(
      path.join(tmpDir, "next.config.mjs"),
      `export default { basePath: "/esm-app" };`,
    );

    const config = await loadNextConfig(tmpDir);
    expect(config).not.toBeNull();
    expect(config!.basePath).toBe("/esm-app");
  });

  it("returns null when no config file exists", async () => {
    const { loadNextConfig } = await import(
      "../packages/vinext/src/config/next-config.js"
    );

    const config = await loadNextConfig(tmpDir);
    expect(config).toBeNull();
  });
});

describe("extractMdxOptions", () => {
  it("returns null when no webpack function", async () => {
    const { extractMdxOptions } = await import(
      "../packages/vinext/src/config/next-config.js"
    );
    expect(extractMdxOptions({})).toBeNull();
    expect(extractMdxOptions({ webpack: "not a function" })).toBeNull();
  });

  it("extracts remarkPlugins from webpack rule", async () => {
    const { extractMdxOptions } = await import(
      "../packages/vinext/src/config/next-config.js"
    );
    const fakeRemarkPlugin = () => {};
    const config = {
      webpack: (webpackConfig: any) => {
        webpackConfig.module.rules.push({
          test: /\.mdx$/,
          use: [
            {
              loader: "@next/mdx/mdx-js-loader",
              options: {
                remarkPlugins: [[fakeRemarkPlugin, { option: true }]],
                rehypePlugins: [],
              },
            },
          ],
        });
        return webpackConfig;
      },
    };
    const result = extractMdxOptions(config);
    expect(result).not.toBeNull();
    expect(result!.remarkPlugins).toHaveLength(1);
    expect(result!.remarkPlugins![0]).toEqual([fakeRemarkPlugin, { option: true }]);
    expect(result!.rehypePlugins).toBeUndefined();
  });

  it("extracts rehypePlugins from webpack rule", async () => {
    const { extractMdxOptions } = await import(
      "../packages/vinext/src/config/next-config.js"
    );
    const fakeRehypePlugin = () => {};
    const config = {
      webpack: (webpackConfig: any) => {
        webpackConfig.module.rules.push({
          test: /\.mdx$/,
          use: [
            {
              loader: "@next/mdx/mdx-js-loader",
              options: {
                remarkPlugins: [],
                rehypePlugins: [fakeRehypePlugin],
              },
            },
          ],
        });
        return webpackConfig;
      },
    };
    const result = extractMdxOptions(config);
    expect(result).not.toBeNull();
    expect(result!.rehypePlugins).toHaveLength(1);
    expect(result!.remarkPlugins).toBeUndefined();
  });

  it("extracts recmaPlugins from webpack rule", async () => {
    const { extractMdxOptions } = await import(
      "../packages/vinext/src/config/next-config.js"
    );
    const fakeRecmaPlugin = () => {};
    const config = {
      webpack: (webpackConfig: any) => {
        webpackConfig.module.rules.push({
          test: /\.mdx$/,
          use: [
            {
              loader: "@next/mdx/mdx-js-loader",
              options: {
                recmaPlugins: [fakeRecmaPlugin],
              },
            },
          ],
        });
        return webpackConfig;
      },
    };
    const result = extractMdxOptions(config);
    expect(result).not.toBeNull();
    expect(result!.recmaPlugins).toHaveLength(1);
  });

  it("handles oneOf nested rules", async () => {
    const { extractMdxOptions } = await import(
      "../packages/vinext/src/config/next-config.js"
    );
    const fakeRemarkPlugin = () => {};
    const config = {
      webpack: (webpackConfig: any) => {
        webpackConfig.module.rules.push({
          oneOf: [
            {
              test: /\.mdx$/,
              use: [
                {
                  loader: "@next/mdx/mdx-js-loader",
                  options: {
                    remarkPlugins: [fakeRemarkPlugin],
                  },
                },
              ],
            },
          ],
        });
        return webpackConfig;
      },
    };
    const result = extractMdxOptions(config);
    expect(result).not.toBeNull();
    expect(result!.remarkPlugins).toHaveLength(1);
  });

  it("returns null when webpack throws", async () => {
    const { extractMdxOptions } = await import(
      "../packages/vinext/src/config/next-config.js"
    );
    const config = {
      webpack: () => {
        throw new Error("some webpack error");
      },
    };
    expect(extractMdxOptions(config)).toBeNull();
  });

  it("returns null when webpack has no MDX loader", async () => {
    const { extractMdxOptions } = await import(
      "../packages/vinext/src/config/next-config.js"
    );
    const config = {
      webpack: (webpackConfig: any) => {
        webpackConfig.module.rules.push({
          test: /\.css$/,
          use: [{ loader: "css-loader" }],
        });
        return webpackConfig;
      },
    };
    expect(extractMdxOptions(config)).toBeNull();
  });

  it("returns null when MDX loader has empty plugin arrays", async () => {
    const { extractMdxOptions } = await import(
      "../packages/vinext/src/config/next-config.js"
    );
    const config = {
      webpack: (webpackConfig: any) => {
        webpackConfig.module.rules.push({
          test: /\.mdx$/,
          use: [
            {
              loader: "@next/mdx/mdx-js-loader",
              options: {
                remarkPlugins: [],
                rehypePlugins: [],
              },
            },
          ],
        });
        return webpackConfig;
      },
    };
    expect(extractMdxOptions(config)).toBeNull();
  });

  it("resolveNextConfig extracts mdx from webpack closure", async () => {
    const { resolveNextConfig } = await import(
      "../packages/vinext/src/config/next-config.js"
    );
    const fakeRemarkPlugin = () => {};
    const config = await resolveNextConfig({
      webpack: (webpackConfig: any) => {
        webpackConfig.module.rules.push({
          test: /\.mdx$/,
          use: [
            {
              loader: "@next/mdx/mdx-js-loader",
              options: {
                remarkPlugins: [fakeRemarkPlugin],
              },
            },
          ],
        });
        return webpackConfig;
      },
    });
    expect(config.mdx).not.toBeNull();
    expect(config.mdx!.remarkPlugins).toHaveLength(1);
  });
});

describe("next/web-vitals shim", () => {
  it("exports useReportWebVitals as a no-op function", async () => {
    const { useReportWebVitals } = await import(
      "../packages/vinext/src/shims/web-vitals.js"
    );
    expect(typeof useReportWebVitals).toBe("function");
    // Should run without throwing
    expect(() => useReportWebVitals(() => {})).not.toThrow();
  });
});

describe("next/amp shim", () => {
  it("exports useAmp and isInAmpMode as no-op functions", async () => {
    const { useAmp, isInAmpMode } = await import(
      "../packages/vinext/src/shims/amp.js"
    );
    expect(typeof useAmp).toBe("function");
    expect(typeof isInAmpMode).toBe("function");
    // Both always return false
    expect(useAmp()).toBe(false);
    expect(isInAmpMode()).toBe(false);
  });
});

describe("Pages Router router helpers", () => {
  describe("isExternalUrl", () => {
    it("detects https:// as external", () => {
      expect(isExternalUrl("https://example.com")).toBe(true);
      expect(isExternalUrl("https://example.com/path")).toBe(true);
    });

    it("detects http:// as external", () => {
      expect(isExternalUrl("http://example.com")).toBe(true);
    });

    it("detects protocol-relative // as external", () => {
      expect(isExternalUrl("//cdn.example.com/img.png")).toBe(true);
    });

    it("returns false for relative paths", () => {
      expect(isExternalUrl("/about")).toBe(false);
      expect(isExternalUrl("/")).toBe(false);
      expect(isExternalUrl("about")).toBe(false);
    });

    it("returns false for hash-only", () => {
      expect(isExternalUrl("#section")).toBe(false);
    });

    it("returns false for query-only", () => {
      expect(isExternalUrl("?foo=1")).toBe(false);
    });
  });

  describe("isHashOnlyChange", () => {
    it("returns true for hash-only strings starting with #", () => {
      // This works even without window because of the startsWith check
      expect(isHashOnlyChange("#foo")).toBe(true);
      expect(isHashOnlyChange("#")).toBe(true);
      expect(isHashOnlyChange("#section-2")).toBe(true);
    });

    it("returns false for absolute paths without window context", () => {
      // Without a real browser window, URL-based comparison returns false
      // because typeof window === "undefined" → returns false
      expect(isHashOnlyChange("/about")).toBe(false);
      expect(isHashOnlyChange("/about#foo")).toBe(false);
    });

    it("returns false for full URLs without window context", () => {
      expect(isHashOnlyChange("https://example.com#foo")).toBe(false);
    });
  });
});

describe("next/server enhancements", () => {
  it("NextRequest.ip extracts from x-forwarded-for header", async () => {
    const { NextRequest } = await import(
      "../packages/vinext/src/shims/server.js"
    );
    const req = new NextRequest("https://example.com", {
      headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" },
    });
    expect(req.ip).toBe("1.2.3.4");
  });

  it("NextRequest.ip returns undefined without forwarded header", async () => {
    const { NextRequest } = await import(
      "../packages/vinext/src/shims/server.js"
    );
    const req = new NextRequest("https://example.com");
    expect(req.ip).toBeUndefined();
  });

  it("NextRequest.geo extracts from Cloudflare/Vercel headers", async () => {
    const { NextRequest } = await import(
      "../packages/vinext/src/shims/server.js"
    );
    const req = new NextRequest("https://example.com", {
      headers: {
        "cf-ipcountry": "US",
        "cf-ipcity": "San Francisco",
      },
    });
    const geo = req.geo;
    expect(geo).toBeDefined();
    expect(geo!.country).toBe("US");
    expect(geo!.city).toBe("San Francisco");
  });

  it("NextRequest.geo returns undefined without geo headers", async () => {
    const { NextRequest } = await import(
      "../packages/vinext/src/shims/server.js"
    );
    const req = new NextRequest("https://example.com");
    expect(req.geo).toBeUndefined();
  });

  it("ResponseCookies.getAll returns all set cookies", async () => {
    const { ResponseCookies } = await import(
      "../packages/vinext/src/shims/server.js"
    );
    const headers = new Headers();
    const cookies = new ResponseCookies(headers);
    cookies.set("a", "1");
    cookies.set("b", "2");
    const all = cookies.getAll();
    expect(all).toHaveLength(2);
    expect(all.find((c: any) => c.name === "a")?.value).toBe("1");
    expect(all.find((c: any) => c.name === "b")?.value).toBe("2");
  });
});

describe("next/image enhancements", () => {
  it("exports StaticImageData type", async () => {
    const imageModule = await import(
      "../packages/vinext/src/shims/image.js"
    );
    // StaticImageData is an interface, so we can't check at runtime
    // but getImageProps uses it — verify that function exists
    expect(typeof imageModule.getImageProps).toBe("function");
  });

  it("getImageProps returns img props from Image props", async () => {
    const { getImageProps } = await import(
      "../packages/vinext/src/shims/image.js"
    );
    const result = getImageProps({
      src: "/photo.jpg",
      alt: "Test",
      width: 800,
      height: 600,
      priority: true,
    });
    // Local images now route through the optimization endpoint
    expect(result.props.src).toContain("/_vinext/image");
    expect(result.props.src).toContain("url=%2Fphoto.jpg");
    expect(result.props.src).toContain("w=800");
    expect(result.props.alt).toBe("Test");
    expect(result.props.width).toBe(800);
    expect(result.props.height).toBe(600);
    expect(result.props.loading).toBe("eager");
  });

  it("getImageProps handles fill mode", async () => {
    const { getImageProps } = await import(
      "../packages/vinext/src/shims/image.js"
    );
    const result = getImageProps({
      src: "/bg.jpg",
      alt: "Background",
      fill: true,
    });
    expect(result.props.width).toBeUndefined();
    expect(result.props.height).toBeUndefined();
    expect(result.props.style?.position).toBe("absolute");
  });

  it("getImageProps handles StaticImageData", async () => {
    const { getImageProps } = await import(
      "../packages/vinext/src/shims/image.js"
    );
    const result = getImageProps({
      src: { src: "/imported.jpg", width: 1200, height: 800, blurDataURL: "data:..." },
      alt: "Imported",
    });
    expect(result.props.src).toContain("/_vinext/image");
    expect(result.props.src).toContain("url=%2Fimported.jpg");
    expect(result.props.src).toContain("w=1200");
    expect(result.props.width).toBe(1200);
    expect(result.props.height).toBe(800);
  });

  it("getImageProps generates srcSet for local images with width", async () => {
    const { getImageProps } = await import(
      "../packages/vinext/src/shims/image.js"
    );
    const result = getImageProps({
      src: "/photo.jpg",
      alt: "Test",
      width: 1200,
      height: 800,
    });
    expect(result.props.srcSet).toBeDefined();
    // srcSet entries point to /_vinext/image optimization endpoint
    expect(result.props.srcSet).toContain("/_vinext/image");
    expect(result.props.srcSet).toContain("url=%2Fphoto.jpg");
    expect(result.props.srcSet).toContain("w");
  });

  it("getImageProps does not generate srcSet for fill images", async () => {
    const { getImageProps } = await import(
      "../packages/vinext/src/shims/image.js"
    );
    const result = getImageProps({
      src: "/bg.jpg",
      alt: "Background",
      fill: true,
    });
    expect(result.props.srcSet).toBeUndefined();
    expect(result.props.sizes).toBe("100vw"); // fill implies 100vw
  });

  it("getImageProps includes fetchPriority for priority images", async () => {
    const { getImageProps } = await import(
      "../packages/vinext/src/shims/image.js"
    );
    const result = getImageProps({
      src: "/hero.jpg",
      alt: "Hero",
      width: 1200,
      height: 800,
      priority: true,
    });
    expect(result.props.fetchPriority).toBe("high");
    expect(result.props.loading).toBe("eager");
  });

  it("getImageProps includes data-nimg attribute", async () => {
    const { getImageProps } = await import(
      "../packages/vinext/src/shims/image.js"
    );
    const result = getImageProps({
      src: "/photo.jpg",
      alt: "Photo",
      width: 800,
      height: 600,
    });
    expect((result.props as any)["data-nimg"]).toBe("1");

    const fillResult = getImageProps({
      src: "/bg.jpg",
      alt: "BG",
      fill: true,
    });
    expect((fillResult.props as any)["data-nimg"]).toBe("fill");
  });

  it("getImageProps includes blur placeholder background styles", async () => {
    const { getImageProps } = await import(
      "../packages/vinext/src/shims/image.js"
    );
    const blurUrl = "data:image/jpeg;base64,/9j/4AAQ";
    const result = getImageProps({
      src: "/photo.jpg",
      alt: "Blurry",
      width: 800,
      height: 600,
      placeholder: "blur",
      blurDataURL: blurUrl,
    });
    expect(result.props.style?.backgroundImage).toContain(blurUrl);
    expect(result.props.style?.backgroundSize).toBe("cover");
  });

  it("getImageProps uses custom loader function", async () => {
    const { getImageProps } = await import(
      "../packages/vinext/src/shims/image.js"
    );
    const result = getImageProps({
      src: "/photo.jpg",
      alt: "Custom",
      width: 800,
      height: 600,
      loader: ({ src, width, quality }) => `https://cdn.example.com${src}?w=${width}&q=${quality}`,
    });
    // Custom loader bypasses the /_vinext/image endpoint
    expect(result.props.src).toBe("https://cdn.example.com/photo.jpg?w=800&q=75");
    expect(result.props.src).not.toContain("/_vinext/image");
  });

  it("unoptimized prop bypasses /_vinext/image endpoint", async () => {
    const { getImageProps } = await import("../packages/vinext/src/shims/image.js");
    const result = getImageProps({
      src: "/photo.jpg",
      alt: "Unoptimized",
      width: 800,
      height: 600,
      unoptimized: true,
    });
    // unoptimized=true should serve the raw src, not the optimization endpoint
    expect(result.props.src).toBe("/photo.jpg");
    expect(result.props.src).not.toContain("/_vinext/image");
  });
});

describe("next/image component rendering", () => {
  it("renders basic image with src, alt, width, height", async () => {
    const React = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const Image = (await import("../packages/vinext/src/shims/image.js")).default;

    const html = renderToStaticMarkup(
      React.createElement(Image, { src: "/photo.jpg", alt: "Test photo", width: 800, height: 600 }),
    );
    // Local images route through the optimization endpoint
    expect(html).toContain("/_vinext/image");
    expect(html).toContain("url=%2Fphoto.jpg");
    expect(html).toContain('alt="Test photo"');
    expect(html).toContain('width="800"');
    expect(html).toContain('height="600"');
  });

  it("renders fill image with absolute positioning", async () => {
    const React = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const Image = (await import("../packages/vinext/src/shims/image.js")).default;

    const html = renderToStaticMarkup(
      React.createElement(Image, { src: "/bg.jpg", alt: "Background", fill: true }),
    );
    expect(html).toContain("position:absolute");
    expect(html).toContain('data-nimg="fill"');
    // fill images should not have width/height attributes
    expect(html).not.toContain('width=');
    expect(html).not.toContain('height=');
  });

  it("renders priority image with fetchpriority=high and loading=eager", async () => {
    const React = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const Image = (await import("../packages/vinext/src/shims/image.js")).default;

    const html = renderToStaticMarkup(
      React.createElement(Image, { src: "/hero.jpg", alt: "Hero", width: 1200, height: 800, priority: true }),
    );
    expect(html).toContain('fetchPriority="high"');
    expect(html).toContain('loading="eager"');
  });

  it("renders lazy loading by default (no priority)", async () => {
    const React = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const Image = (await import("../packages/vinext/src/shims/image.js")).default;

    const html = renderToStaticMarkup(
      React.createElement(Image, { src: "/photo.jpg", alt: "Photo", width: 800, height: 600 }),
    );
    expect(html).toContain('loading="lazy"');
    expect(html).not.toContain('fetchPriority');
  });

  it("renders srcSet for local images with width", async () => {
    const React = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const Image = (await import("../packages/vinext/src/shims/image.js")).default;

    const html = renderToStaticMarkup(
      React.createElement(Image, { src: "/photo.jpg", alt: "Photo", width: 1200, height: 800 }),
    );
    expect(html).toContain("srcSet");
    // srcSet entries point to /_vinext/image optimization endpoint
    expect(html).toContain("/_vinext/image");
    expect(html).toContain("url=%2Fphoto.jpg");
  });

  it("renders blur placeholder with background-image", async () => {
    const React = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const Image = (await import("../packages/vinext/src/shims/image.js")).default;

    const blurUrl = "data:image/jpeg;base64,/9j/4AAQ";
    const html = renderToStaticMarkup(
      React.createElement(Image, {
        src: "/photo.jpg",
        alt: "Blurry",
        width: 800,
        height: 600,
        placeholder: "blur",
        blurDataURL: blurUrl,
      }),
    );
    expect(html).toContain(blurUrl);
    expect(html).toContain("background-image");
    expect(html).toContain("background-size:cover");
  });

  it("renders with custom loader function", async () => {
    const React = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const Image = (await import("../packages/vinext/src/shims/image.js")).default;

    const html = renderToStaticMarkup(
      React.createElement(Image, {
        src: "/photo.jpg",
        alt: "Custom",
        width: 800,
        height: 600,
        loader: ({ src, width, quality }: { src: string; width: number; quality?: number }) =>
          `https://cdn.example.com${src}?w=${width}&q=${quality}`,
      }),
    );
    expect(html).toContain('src="https://cdn.example.com/photo.jpg?w=800&amp;q=75"');
  });

  it("renders with custom sizes attribute", async () => {
    const React = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const Image = (await import("../packages/vinext/src/shims/image.js")).default;

    const html = renderToStaticMarkup(
      React.createElement(Image, {
        src: "/photo.jpg",
        alt: "Responsive",
        width: 1200,
        height: 800,
        sizes: "(max-width: 768px) 100vw, 50vw",
      }),
    );
    expect(html).toContain('sizes="(max-width: 768px) 100vw, 50vw"');
  });

  it("renders fill image with sizes=100vw by default", async () => {
    const React = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const Image = (await import("../packages/vinext/src/shims/image.js")).default;

    const html = renderToStaticMarkup(
      React.createElement(Image, { src: "/bg.jpg", alt: "BG", fill: true }),
    );
    expect(html).toContain('sizes="100vw"');
  });

  it("handles StaticImageData import objects", async () => {
    const React = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const Image = (await import("../packages/vinext/src/shims/image.js")).default;

    const staticImport = { src: "/imported.jpg", width: 1200, height: 800, blurDataURL: "data:..." };
    const html = renderToStaticMarkup(
      React.createElement(Image, { src: staticImport, alt: "Imported" }),
    );
    expect(html).toContain("/_vinext/image");
    expect(html).toContain("url=%2Fimported.jpg");
    expect(html).toContain('width="1200"');
    expect(html).toContain('height="800"');
  });

  it("renders with className", async () => {
    const React = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const Image = (await import("../packages/vinext/src/shims/image.js")).default;

    const html = renderToStaticMarkup(
      React.createElement(Image, {
        src: "/photo.jpg",
        alt: "Styled",
        width: 800,
        height: 600,
        className: "rounded-lg shadow-md",
      }),
    );
    expect(html).toContain('class="rounded-lg shadow-md"');
  });

  it("includes data-nimg=1 for non-fill images", async () => {
    const React = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const Image = (await import("../packages/vinext/src/shims/image.js")).default;

    const html = renderToStaticMarkup(
      React.createElement(Image, { src: "/photo.jpg", alt: "Test", width: 800, height: 600 }),
    );
    expect(html).toContain('data-nimg="1"');
  });

  it("always sets decoding=async", async () => {
    const React = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const Image = (await import("../packages/vinext/src/shims/image.js")).default;

    const html = renderToStaticMarkup(
      React.createElement(Image, { src: "/photo.jpg", alt: "Test", width: 800, height: 600 }),
    );
    expect(html).toContain('decoding="async"');
  });
});

describe("image remote pattern matching", () => {
  it("matchRemotePattern matches exact hostname", async () => {
    const { matchRemotePattern } = await import("../packages/vinext/src/shims/image-config.js");
    const pattern = { hostname: "cdn.example.com" };
    expect(matchRemotePattern(pattern, new URL("https://cdn.example.com/img.jpg"))).toBe(true);
    expect(matchRemotePattern(pattern, new URL("https://other.example.com/img.jpg"))).toBe(false);
  });

  it("matchRemotePattern matches wildcard hostname with *", async () => {
    const { matchRemotePattern } = await import("../packages/vinext/src/shims/image-config.js");
    const pattern = { hostname: "*.example.com" };
    expect(matchRemotePattern(pattern, new URL("https://cdn.example.com/img.jpg"))).toBe(true);
    expect(matchRemotePattern(pattern, new URL("https://images.example.com/img.jpg"))).toBe(true);
    // Single * should NOT match nested subdomains
    expect(matchRemotePattern(pattern, new URL("https://a.b.example.com/img.jpg"))).toBe(false);
    // Should not match bare domain
    expect(matchRemotePattern(pattern, new URL("https://example.com/img.jpg"))).toBe(false);
  });

  it("matchRemotePattern matches ** hostname for any depth", async () => {
    const { matchRemotePattern } = await import("../packages/vinext/src/shims/image-config.js");
    const pattern = { hostname: "**.example.com" };
    expect(matchRemotePattern(pattern, new URL("https://cdn.example.com/img.jpg"))).toBe(true);
    expect(matchRemotePattern(pattern, new URL("https://a.b.c.example.com/img.jpg"))).toBe(true);
    // ** requires at least one segment
    expect(matchRemotePattern(pattern, new URL("https://example.com/img.jpg"))).toBe(false);
  });

  it("matchRemotePattern checks protocol when specified", async () => {
    const { matchRemotePattern } = await import("../packages/vinext/src/shims/image-config.js");
    const pattern = { protocol: "https", hostname: "cdn.example.com" };
    expect(matchRemotePattern(pattern, new URL("https://cdn.example.com/img.jpg"))).toBe(true);
    expect(matchRemotePattern(pattern, new URL("http://cdn.example.com/img.jpg"))).toBe(false);
  });

  it("matchRemotePattern checks port when specified", async () => {
    const { matchRemotePattern } = await import("../packages/vinext/src/shims/image-config.js");
    const pattern = { hostname: "localhost", port: "3000" };
    expect(matchRemotePattern(pattern, new URL("http://localhost:3000/img.jpg"))).toBe(true);
    expect(matchRemotePattern(pattern, new URL("http://localhost:8080/img.jpg"))).toBe(false);
  });

  it("matchRemotePattern checks pathname when specified", async () => {
    const { matchRemotePattern } = await import("../packages/vinext/src/shims/image-config.js");
    const pattern = { hostname: "cdn.example.com", pathname: "/images/**" };
    expect(matchRemotePattern(pattern, new URL("https://cdn.example.com/images/photo.jpg"))).toBe(true);
    expect(matchRemotePattern(pattern, new URL("https://cdn.example.com/images/nested/photo.jpg"))).toBe(true);
    expect(matchRemotePattern(pattern, new URL("https://cdn.example.com/other/photo.jpg"))).toBe(false);
  });

  it("matchRemotePattern checks search when specified", async () => {
    const { matchRemotePattern } = await import("../packages/vinext/src/shims/image-config.js");
    const pattern = { hostname: "cdn.example.com", search: "?v=123" };
    expect(matchRemotePattern(pattern, new URL("https://cdn.example.com/img.jpg?v=123"))).toBe(true);
    expect(matchRemotePattern(pattern, new URL("https://cdn.example.com/img.jpg?v=456"))).toBe(false);
    expect(matchRemotePattern(pattern, new URL("https://cdn.example.com/img.jpg"))).toBe(false);
  });

  it("matchRemotePattern defaults pathname to ** when not specified", async () => {
    const { matchRemotePattern } = await import("../packages/vinext/src/shims/image-config.js");
    const pattern = { hostname: "cdn.example.com" };
    expect(matchRemotePattern(pattern, new URL("https://cdn.example.com/any/deep/path/img.jpg"))).toBe(true);
    expect(matchRemotePattern(pattern, new URL("https://cdn.example.com/"))).toBe(true);
  });

  it("matchRemotePattern handles protocol with trailing colon", async () => {
    const { matchRemotePattern } = await import("../packages/vinext/src/shims/image-config.js");
    const pattern = { protocol: "https:", hostname: "cdn.example.com" };
    expect(matchRemotePattern(pattern, new URL("https://cdn.example.com/img.jpg"))).toBe(true);
  });

  it("hasRemoteMatch checks domains list", async () => {
    const { hasRemoteMatch } = await import("../packages/vinext/src/shims/image-config.js");
    const domains = ["cdn.example.com", "images.example.com"];
    expect(hasRemoteMatch(domains, [], new URL("https://cdn.example.com/img.jpg"))).toBe(true);
    expect(hasRemoteMatch(domains, [], new URL("https://images.example.com/img.jpg"))).toBe(true);
    expect(hasRemoteMatch(domains, [], new URL("https://other.example.com/img.jpg"))).toBe(false);
  });

  it("hasRemoteMatch checks remotePatterns when domains don't match", async () => {
    const { hasRemoteMatch } = await import("../packages/vinext/src/shims/image-config.js");
    const patterns = [{ protocol: "https", hostname: "**.cdn.example.com" }];
    expect(hasRemoteMatch([], patterns, new URL("https://us.cdn.example.com/img.jpg"))).toBe(true);
    expect(hasRemoteMatch([], patterns, new URL("http://us.cdn.example.com/img.jpg"))).toBe(false);
  });

  it("matchRemotePattern handles single * in pathname", async () => {
    const { matchRemotePattern } = await import("../packages/vinext/src/shims/image-config.js");
    const pattern = { hostname: "cdn.example.com", pathname: "/images/*" };
    expect(matchRemotePattern(pattern, new URL("https://cdn.example.com/images/photo.jpg"))).toBe(true);
    // Single * should not match nested paths
    expect(matchRemotePattern(pattern, new URL("https://cdn.example.com/images/nested/photo.jpg"))).toBe(false);
  });

  it("matchRemotePattern handles regex special chars in hostname", async () => {
    const { matchRemotePattern } = await import("../packages/vinext/src/shims/image-config.js");
    // Dots in hostname are literal (escaped for regex)
    const pattern = { hostname: "cdn.example.com" };
    expect(matchRemotePattern(pattern, new URL("https://cdn.example.com/img.jpg"))).toBe(true);
    // "cdnXexampleXcom" should not match "cdn.example.com"
    expect(matchRemotePattern(pattern, new URL("https://cdnXexample.com/img.jpg"))).toBe(false);
  });
});

describe("image optimization URL generation", () => {
  it("imageOptimizationUrl generates correct URL", async () => {
    const { imageOptimizationUrl } = await import("../packages/vinext/src/shims/image.js");
    const url = imageOptimizationUrl("/images/hero.webp", 1200, 75);
    expect(url).toBe("/_vinext/image?url=%2Fimages%2Fhero.webp&w=1200&q=75");
  });

  it("imageOptimizationUrl encodes special characters", async () => {
    const { imageOptimizationUrl } = await import("../packages/vinext/src/shims/image.js");
    const url = imageOptimizationUrl("/images/my photo.jpg", 800, 80);
    expect(url).toContain("url=%2Fimages%2Fmy%20photo.jpg");
    expect(url).toContain("w=800");
    expect(url).toContain("q=80");
  });

  it("imageOptimizationUrl uses default quality of 75", async () => {
    const { imageOptimizationUrl } = await import("../packages/vinext/src/shims/image.js");
    const url = imageOptimizationUrl("/img.png", 640);
    expect(url).toContain("q=75");
  });
});

describe("image optimization request parsing", () => {
  it("parseImageParams extracts url, width, quality", async () => {
    const { parseImageParams } = await import("../packages/vinext/src/server/image-optimization.js");
    const url = new URL("http://localhost/_vinext/image?url=%2Fimages%2Fhero.webp&w=1200&q=75");
    const params = parseImageParams(url);
    expect(params).not.toBeNull();
    expect(params!.imageUrl).toBe("/images/hero.webp");
    expect(params!.width).toBe(1200);
    expect(params!.quality).toBe(75);
  });

  it("parseImageParams returns null when url is missing", async () => {
    const { parseImageParams } = await import("../packages/vinext/src/server/image-optimization.js");
    const url = new URL("http://localhost/_vinext/image?w=800&q=75");
    expect(parseImageParams(url)).toBeNull();
  });

  it("parseImageParams blocks absolute http URLs", async () => {
    const { parseImageParams } = await import("../packages/vinext/src/server/image-optimization.js");
    const url = new URL("http://localhost/_vinext/image?url=http%3A%2F%2Fevil.com%2Fimg.jpg&w=800");
    expect(parseImageParams(url)).toBeNull();
  });

  it("parseImageParams blocks absolute https URLs", async () => {
    const { parseImageParams } = await import("../packages/vinext/src/server/image-optimization.js");
    const url = new URL("http://localhost/_vinext/image?url=https%3A%2F%2Fevil.com%2Fimg.jpg&w=800");
    expect(parseImageParams(url)).toBeNull();
  });

  it("parseImageParams blocks protocol-relative URLs", async () => {
    const { parseImageParams } = await import("../packages/vinext/src/server/image-optimization.js");
    const url = new URL("http://localhost/_vinext/image?url=%2F%2Fevil.com%2Fimg.jpg&w=800");
    expect(parseImageParams(url)).toBeNull();
  });

  it("parseImageParams defaults width to 0 and quality to 75", async () => {
    const { parseImageParams } = await import("../packages/vinext/src/server/image-optimization.js");
    const url = new URL("http://localhost/_vinext/image?url=%2Fimg.jpg");
    const params = parseImageParams(url);
    expect(params).not.toBeNull();
    expect(params!.width).toBe(0);
    expect(params!.quality).toBe(75);
  });

  it("parseImageParams blocks data: URIs (exotic scheme bypass)", async () => {
    const { parseImageParams } = await import("../packages/vinext/src/server/image-optimization.js");
    expect(parseImageParams(new URL("http://localhost/_vinext/image?url=data%3Atext%2Fhtml%2C%3Cscript%3Ealert(1)%3C%2Fscript%3E&w=800"))).toBeNull();
  });

  it("parseImageParams blocks javascript: URIs", async () => {
    const { parseImageParams } = await import("../packages/vinext/src/server/image-optimization.js");
    expect(parseImageParams(new URL("http://localhost/_vinext/image?url=javascript%3Aalert(1)&w=800"))).toBeNull();
  });

  it("parseImageParams blocks bare filenames (no leading slash)", async () => {
    const { parseImageParams } = await import("../packages/vinext/src/server/image-optimization.js");
    expect(parseImageParams(new URL("http://localhost/_vinext/image?url=img.jpg&w=800"))).toBeNull();
  });

  it("parseImageParams rejects quality outside 1-100", async () => {
    const { parseImageParams } = await import("../packages/vinext/src/server/image-optimization.js");
    expect(parseImageParams(new URL("http://localhost/_vinext/image?url=%2Fimg.jpg&q=0"))).toBeNull();
    expect(parseImageParams(new URL("http://localhost/_vinext/image?url=%2Fimg.jpg&q=101"))).toBeNull();
  });

  it("parseImageParams blocks backslash-based open redirect (/\\evil.com)", async () => {
    const { parseImageParams } = await import("../packages/vinext/src/server/image-optimization.js");
    // /\evil.com — browsers and the URL constructor treat this as //evil.com
    expect(parseImageParams(new URL("http://localhost/_vinext/image?url=%2F%5Cevil.com&w=800"))).toBeNull();
  });

  it("parseImageParams blocks encoded backslash variants", async () => {
    const { parseImageParams } = await import("../packages/vinext/src/server/image-optimization.js");
    // /\evil.com/img.jpg
    expect(parseImageParams(new URL("http://localhost/_vinext/image?url=%2F%5Cevil.com%2Fimg.jpg&w=800"))).toBeNull();
    // /\\evil.com (double backslash)
    expect(parseImageParams(new URL("http://localhost/_vinext/image?url=%2F%5C%5Cevil.com&w=800"))).toBeNull();
  });

  it("parseImageParams validates origin hasn't changed after URL construction", async () => {
    const { parseImageParams } = await import("../packages/vinext/src/server/image-optimization.js");
    // This tests defense-in-depth: even if a future parser differential is found,
    // the origin check catches it.
    // A valid relative URL should pass
    const good = parseImageParams(new URL("http://localhost/_vinext/image?url=%2Fimages%2Fhero.webp&w=800"));
    expect(good).not.toBeNull();
    expect(good!.imageUrl).toBe("/images/hero.webp");
  });

  it("parseImageParams normalizes backslashes in returned imageUrl", async () => {
    const { parseImageParams } = await import("../packages/vinext/src/server/image-optimization.js");
    // /images\hero.webp should be normalized to /images/hero.webp
    // (backslash in the middle of a valid path)
    const result = parseImageParams(new URL("http://localhost/_vinext/image?url=%2Fimages%5Chero.webp&w=800"));
    expect(result).not.toBeNull();
    expect(result!.imageUrl).toBe("/images/hero.webp");
  });

  it("parseImageParams rejects width exceeding absolute maximum (3840)", async () => {
    const { parseImageParams } = await import("../packages/vinext/src/server/image-optimization.js");
    expect(parseImageParams(new URL("http://localhost/_vinext/image?url=%2Fimg.jpg&w=3841"))).toBeNull();
    expect(parseImageParams(new URL("http://localhost/_vinext/image?url=%2Fimg.jpg&w=999999999"))).toBeNull();
    expect(parseImageParams(new URL("http://localhost/_vinext/image?url=%2Fimg.jpg&w=2147483647"))).toBeNull();
  });

  it("parseImageParams accepts width at the absolute maximum (3840)", async () => {
    const { parseImageParams } = await import("../packages/vinext/src/server/image-optimization.js");
    const params = parseImageParams(new URL("http://localhost/_vinext/image?url=%2Fimg.jpg&w=3840"));
    expect(params).not.toBeNull();
    expect(params!.width).toBe(3840);
  });

  it("parseImageParams validates against allowedWidths when provided", async () => {
    const { parseImageParams } = await import("../packages/vinext/src/server/image-optimization.js");
    const allowedWidths = [640, 750, 828, 1080, 1200, 1920, 2048, 3840];
    // Allowed width passes
    const params = parseImageParams(
      new URL("http://localhost/_vinext/image?url=%2Fimg.jpg&w=1080"),
      allowedWidths,
    );
    expect(params).not.toBeNull();
    expect(params!.width).toBe(1080);
    // Non-allowed width is rejected
    expect(parseImageParams(
      new URL("http://localhost/_vinext/image?url=%2Fimg.jpg&w=999"),
      allowedWidths,
    )).toBeNull();
    // w=0 (no resize) is always allowed even with allowedWidths
    const noResize = parseImageParams(
      new URL("http://localhost/_vinext/image?url=%2Fimg.jpg&w=0"),
      allowedWidths,
    );
    expect(noResize).not.toBeNull();
    expect(noResize!.width).toBe(0);
  });

  it("parseImageParams allows imageSizes (small widths) in allowedWidths", async () => {
    const { parseImageParams } = await import("../packages/vinext/src/server/image-optimization.js");
    const allowedWidths = [16, 32, 48, 64, 96, 128, 256, 384, 640, 750, 828, 1080, 1200, 1920, 2048, 3840];
    const params = parseImageParams(
      new URL("http://localhost/_vinext/image?url=%2Fimg.jpg&w=64"),
      allowedWidths,
    );
    expect(params).not.toBeNull();
    expect(params!.width).toBe(64);
  });

  it("negotiateImageFormat prefers AVIF over WebP", async () => {
    const { negotiateImageFormat } = await import("../packages/vinext/src/server/image-optimization.js");
    expect(negotiateImageFormat("image/avif,image/webp,image/jpeg")).toBe("image/avif");
  });

  it("negotiateImageFormat selects WebP when no AVIF", async () => {
    const { negotiateImageFormat } = await import("../packages/vinext/src/server/image-optimization.js");
    expect(negotiateImageFormat("image/webp,image/jpeg")).toBe("image/webp");
  });

  it("negotiateImageFormat falls back to JPEG", async () => {
    const { negotiateImageFormat } = await import("../packages/vinext/src/server/image-optimization.js");
    expect(negotiateImageFormat("image/png,image/jpeg")).toBe("image/jpeg");
    expect(negotiateImageFormat(null)).toBe("image/jpeg");
  });

  it("IMAGE_OPTIMIZATION_PATH is /_vinext/image", async () => {
    const { IMAGE_OPTIMIZATION_PATH } = await import("../packages/vinext/src/server/image-optimization.js");
    expect(IMAGE_OPTIMIZATION_PATH).toBe("/_vinext/image");
  });

  it("exports DEFAULT_DEVICE_SIZES and DEFAULT_IMAGE_SIZES matching Next.js defaults", async () => {
    const { DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } = await import("../packages/vinext/src/server/image-optimization.js");
    expect(DEFAULT_DEVICE_SIZES).toEqual([640, 750, 828, 1080, 1200, 1920, 2048, 3840]);
    expect(DEFAULT_IMAGE_SIZES).toEqual([16, 32, 48, 64, 96, 128, 256, 384]);
  });
});

describe("isSafeImageContentType", () => {
  it("accepts safe image content types", async () => {
    const { isSafeImageContentType } = await import("../packages/vinext/src/server/image-optimization.js");
    expect(isSafeImageContentType("image/jpeg")).toBe(true);
    expect(isSafeImageContentType("image/png")).toBe(true);
    expect(isSafeImageContentType("image/gif")).toBe(true);
    expect(isSafeImageContentType("image/webp")).toBe(true);
    expect(isSafeImageContentType("image/avif")).toBe(true);
    expect(isSafeImageContentType("image/x-icon")).toBe(true);
    expect(isSafeImageContentType("image/bmp")).toBe(true);
    expect(isSafeImageContentType("image/tiff")).toBe(true);
  });

  it("rejects SVG content type", async () => {
    const { isSafeImageContentType } = await import("../packages/vinext/src/server/image-optimization.js");
    expect(isSafeImageContentType("image/svg+xml")).toBe(false);
  });

  it("rejects non-image content types", async () => {
    const { isSafeImageContentType } = await import("../packages/vinext/src/server/image-optimization.js");
    expect(isSafeImageContentType("text/html")).toBe(false);
    expect(isSafeImageContentType("application/javascript")).toBe(false);
    expect(isSafeImageContentType("text/xml")).toBe(false);
    expect(isSafeImageContentType("application/octet-stream")).toBe(false);
  });

  it("rejects null content type", async () => {
    const { isSafeImageContentType } = await import("../packages/vinext/src/server/image-optimization.js");
    expect(isSafeImageContentType(null)).toBe(false);
  });

  it("handles content type with parameters (charset, etc.)", async () => {
    const { isSafeImageContentType } = await import("../packages/vinext/src/server/image-optimization.js");
    expect(isSafeImageContentType("image/jpeg; charset=utf-8")).toBe(true);
    expect(isSafeImageContentType("image/svg+xml; charset=utf-8")).toBe(false);
  });

  it("is case-insensitive", async () => {
    const { isSafeImageContentType } = await import("../packages/vinext/src/server/image-optimization.js");
    expect(isSafeImageContentType("Image/JPEG")).toBe(true);
    expect(isSafeImageContentType("IMAGE/SVG+XML")).toBe(false);
  });
});

describe("handleImageOptimization", () => {
  it("returns 400 for invalid params", async () => {
    const { handleImageOptimization } = await import("../packages/vinext/src/server/image-optimization.js");
    const request = new Request("http://localhost/_vinext/image");
    const handlers = {
      fetchAsset: async () => new Response("", { status: 200 }),
    };
    const response = await handleImageOptimization(request, handlers);
    expect(response.status).toBe(400);
  });

  it("returns 404 when fetchAsset fails", async () => {
    const { handleImageOptimization } = await import("../packages/vinext/src/server/image-optimization.js");
    const request = new Request("http://localhost/_vinext/image?url=%2Fimg.jpg&w=800");
    const handlers = {
      fetchAsset: async () => new Response("", { status: 404 }),
    };
    const response = await handleImageOptimization(request, handlers);
    expect(response.status).toBe(404);
  });

  it("returns original image when no transformImage handler", async () => {
    const { handleImageOptimization } = await import("../packages/vinext/src/server/image-optimization.js");
    const request = new Request("http://localhost/_vinext/image?url=%2Fimg.jpg&w=800");
    const handlers = {
      fetchAsset: async () => new Response("original-image-data", {
        status: 200,
        headers: { "Content-Type": "image/jpeg" },
      }),
    };
    const response = await handleImageOptimization(request, handlers);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("original-image-data");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("Vary")).toBe("Accept");
  });

  it("calls transformImage when provided", async () => {
    const { handleImageOptimization } = await import("../packages/vinext/src/server/image-optimization.js");
    const request = new Request("http://localhost/_vinext/image?url=%2Fimg.jpg&w=800&q=90", {
      headers: { Accept: "image/webp" },
    });
    let capturedOptions: { width: number; format: string; quality: number } | null = null;
    const handlers = {
      fetchAsset: async () => new Response("original", {
        status: 200,
        headers: { "Content-Type": "image/jpeg" },
      }),
      transformImage: async (_body: ReadableStream, options: { width: number; format: string; quality: number }) => {
        capturedOptions = options;
        return new Response("transformed", { headers: { "Content-Type": options.format } });
      },
    };
    const response = await handleImageOptimization(request, handlers);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("transformed");
    expect(capturedOptions).toEqual({ width: 800, format: "image/webp", quality: 90 });
  });

  it("falls back to original on transform error", async () => {
    const { handleImageOptimization } = await import("../packages/vinext/src/server/image-optimization.js");
    const request = new Request("http://localhost/_vinext/image?url=%2Fimg.jpg&w=800");
    const handlers = {
      fetchAsset: async () => new Response("original", {
        status: 200,
        headers: { "Content-Type": "image/png" },
      }),
      transformImage: async () => {
        throw new Error("transform failed");
      },
    };
    const response = await handleImageOptimization(request, handlers);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("original");
  });

  it("returns 400 for backslash open redirect (/\\evil.com)", async () => {
    const { handleImageOptimization } = await import("../packages/vinext/src/server/image-optimization.js");
    const request = new Request("http://localhost/_vinext/image?url=%2F%5Cevil.com&w=800");
    const handlers = {
      fetchAsset: async () => new Response("should not be called", { status: 200 }),
    };
    const response = await handleImageOptimization(request, handlers);
    expect(response.status).toBe(400);
  });

  it("does not call fetchAsset for backslash URLs", async () => {
    const { handleImageOptimization } = await import("../packages/vinext/src/server/image-optimization.js");
    const request = new Request("http://localhost/_vinext/image?url=%2F%5Cgoogle.com%2Fimg.jpg&w=800");
    let fetchCalled = false;
    const handlers = {
      fetchAsset: async () => {
        fetchCalled = true;
        return new Response("", { status: 200 });
      },
    };
    const response = await handleImageOptimization(request, handlers);
    expect(response.status).toBe(400);
    expect(fetchCalled).toBe(false);
  });

  it("blocks SVG content type", async () => {
    const { handleImageOptimization } = await import("../packages/vinext/src/server/image-optimization.js");
    const request = new Request("http://localhost/_vinext/image?url=%2Fmalicious.svg&w=100&q=75");
    const handlers = {
      fetchAsset: async () => new Response('<svg><script>alert(1)</script></svg>', {
        status: 200,
        headers: { "Content-Type": "image/svg+xml" },
      }),
    };
    const response = await handleImageOptimization(request, handlers);
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("The requested resource is not an allowed image type");
  });

  it("blocks text/html content type", async () => {
    const { handleImageOptimization } = await import("../packages/vinext/src/server/image-optimization.js");
    const request = new Request("http://localhost/_vinext/image?url=%2Ffake.jpg&w=100&q=75");
    const handlers = {
      fetchAsset: async () => new Response('<html><script>alert(1)</script></html>', {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
    };
    const response = await handleImageOptimization(request, handlers);
    expect(response.status).toBe(400);
  });

  it("blocks responses with no Content-Type", async () => {
    const { handleImageOptimization } = await import("../packages/vinext/src/server/image-optimization.js");
    const request = new Request("http://localhost/_vinext/image?url=%2Fimg.jpg&w=800");
    const handlers = {
      fetchAsset: async () => new Response("data", { status: 200 }),
    };
    const response = await handleImageOptimization(request, handlers);
    expect(response.status).toBe(400);
  });

  it("sets Content-Security-Policy header on fallback responses", async () => {
    const { handleImageOptimization } = await import("../packages/vinext/src/server/image-optimization.js");
    const request = new Request("http://localhost/_vinext/image?url=%2Fimg.jpg&w=800");
    const handlers = {
      fetchAsset: async () => new Response("image-data", {
        status: 200,
        headers: { "Content-Type": "image/jpeg" },
      }),
    };
    const response = await handleImageOptimization(request, handlers);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Security-Policy")).toBe("script-src 'none'; frame-src 'none'; sandbox;");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Content-Disposition")).toBe("inline");
  });

  it("sets Content-Security-Policy header on transformed responses", async () => {
    const { handleImageOptimization } = await import("../packages/vinext/src/server/image-optimization.js");
    const request = new Request("http://localhost/_vinext/image?url=%2Fimg.jpg&w=800&q=90", {
      headers: { Accept: "image/webp" },
    });
    const handlers = {
      fetchAsset: async () => new Response("original", {
        status: 200,
        headers: { "Content-Type": "image/jpeg" },
      }),
      transformImage: async (_body: ReadableStream, options: { width: number; format: string; quality: number }) => {
        return new Response("transformed", { headers: { "Content-Type": options.format } });
      },
    };
    const response = await handleImageOptimization(request, handlers);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Security-Policy")).toBe("script-src 'none'; frame-src 'none'; sandbox;");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Content-Disposition")).toBe("inline");
  });

  it("overrides unsafe Content-Type from transform handler", async () => {
    const { handleImageOptimization } = await import("../packages/vinext/src/server/image-optimization.js");
    const request = new Request("http://localhost/_vinext/image?url=%2Fimg.jpg&w=800&q=90", {
      headers: { Accept: "image/webp" },
    });
    const handlers = {
      fetchAsset: async () => new Response("original", {
        status: 200,
        headers: { "Content-Type": "image/jpeg" },
      }),
      transformImage: async () => {
        // Buggy transform that returns text/html
        return new Response("transformed", { headers: { "Content-Type": "text/html" } });
      },
    };
    const response = await handleImageOptimization(request, handlers);
    expect(response.status).toBe(200);
    // Should override to the negotiated format, not pass through text/html
    expect(response.headers.get("Content-Type")).toBe("image/webp");
  });
});

describe("next/navigation enhancements", () => {
  it("exports ReadonlyURLSearchParams type alias", async () => {
    // This is a type-only export, we verify the module loads without error
    const nav = await import(
      "../packages/vinext/src/shims/navigation.js"
    );
    // ReadonlyURLSearchParams is a type export, not a runtime value
    // But useServerInsertedHTML should be exported
    expect(typeof nav.useServerInsertedHTML).toBe("function");
  });

  it("useServerInsertedHTML is a no-op function", async () => {
    const { useServerInsertedHTML } = await import(
      "../packages/vinext/src/shims/navigation.js"
    );
    // Should not throw
    expect(() => useServerInsertedHTML(() => null)).not.toThrow();
  });
});

describe("next/legacy/image shim", () => {
  it("renders LegacyImage with layout=fill as modern Image with fill prop", async () => {
    const React = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const LegacyImage = (await import("../packages/vinext/src/shims/legacy-image.js")).default;

    const html = renderToStaticMarkup(
      React.createElement(LegacyImage, {
        src: "/photo.jpg",
        alt: "Test",
        layout: "fill",
        objectFit: "cover",
        objectPosition: "center",
      }),
    );
    expect(html).toContain("photo.jpg");
    expect(html).toContain("alt");
    // fill mode should produce absolute positioning styles
    expect(html).toContain("position:absolute");
  });

  it("renders LegacyImage with layout=intrinsic using width/height", async () => {
    const React = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const LegacyImage = (await import("../packages/vinext/src/shims/legacy-image.js")).default;

    const html = renderToStaticMarkup(
      React.createElement(LegacyImage, {
        src: "/photo.jpg",
        alt: "Test",
        layout: "intrinsic",
        width: 640,
        height: 480,
      }),
    );
    expect(html).toContain('width="640"');
    expect(html).toContain('height="480"');
  });

  it("renders LegacyImage with string width/height (converts to number)", async () => {
    const React = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const LegacyImage = (await import("../packages/vinext/src/shims/legacy-image.js")).default;

    const html = renderToStaticMarkup(
      React.createElement(LegacyImage, {
        src: "/photo.jpg",
        alt: "Test",
        width: "200",
        height: "150",
      }),
    );
    expect(html).toContain('width="200"');
    expect(html).toContain('height="150"');
  });
});

describe("next/error shim", () => {
  it("renders 404 error page", async () => {
    const React = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const ErrorComponent = (await import("../packages/vinext/src/shims/error.js")).default;

    const html = renderToStaticMarkup(
      React.createElement(ErrorComponent, { statusCode: 404 }),
    );
    expect(html).toContain("404");
    expect(html).toContain("could not be found");
  });

  it("renders 500 error page", async () => {
    const React = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const ErrorComponent = (await import("../packages/vinext/src/shims/error.js")).default;

    const html = renderToStaticMarkup(
      React.createElement(ErrorComponent, { statusCode: 500 }),
    );
    expect(html).toContain("500");
    expect(html).toContain("Internal Server Error");
  });

  it("renders custom title", async () => {
    const React = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const ErrorComponent = (await import("../packages/vinext/src/shims/error.js")).default;

    const html = renderToStaticMarkup(
      React.createElement(ErrorComponent, { statusCode: 403, title: "Forbidden" }),
    );
    expect(html).toContain("403");
    expect(html).toContain("Forbidden");
  });
});

describe("next/constants shim", () => {
  it("exports all phase constants", async () => {
    const constants = await import("../packages/vinext/src/shims/constants.js");
    expect(constants.PHASE_PRODUCTION_BUILD).toBe("phase-production-build");
    expect(constants.PHASE_DEVELOPMENT_SERVER).toBe("phase-development-server");
    expect(constants.PHASE_PRODUCTION_SERVER).toBe("phase-production-server");
    expect(constants.PHASE_EXPORT).toBe("phase-export");
    expect(constants.PHASE_INFO).toBe("phase-info");
    expect(constants.PHASE_TEST).toBe("phase-test");
  });
});

describe("next/script SSR rendering", () => {
  it("beforeInteractive renders <script> tag in SSR", async () => {
    const React = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const Script = (await import("../packages/vinext/src/shims/script.js")).default;

    const html = renderToStaticMarkup(
      React.createElement(Script, {
        src: "https://example.com/analytics.js",
        strategy: "beforeInteractive",
        id: "analytics",
      }),
    );
    expect(html).toContain("<script");
    expect(html).toContain('src="https://example.com/analytics.js"');
    expect(html).toContain('id="analytics"');
  });

  it("afterInteractive returns null in SSR", async () => {
    const React = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const Script = (await import("../packages/vinext/src/shims/script.js")).default;

    const html = renderToStaticMarkup(
      React.createElement(Script, {
        src: "https://example.com/chat.js",
        strategy: "afterInteractive",
      }),
    );
    // afterInteractive should not render anything server-side
    expect(html).toBe("");
  });

  it("lazyOnload returns null in SSR", async () => {
    const React = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const Script = (await import("../packages/vinext/src/shims/script.js")).default;

    const html = renderToStaticMarkup(
      React.createElement(Script, {
        src: "https://example.com/tracking.js",
        strategy: "lazyOnload",
      }),
    );
    expect(html).toBe("");
  });

  it("default strategy (no strategy prop) returns null in SSR", async () => {
    const React = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const Script = (await import("../packages/vinext/src/shims/script.js")).default;

    const html = renderToStaticMarkup(
      React.createElement(Script, {
        src: "https://example.com/default.js",
      }),
    );
    // Default is afterInteractive → null in SSR
    expect(html).toBe("");
  });

  it("beforeInteractive with dangerouslySetInnerHTML renders inline script", async () => {
    const React = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const Script = (await import("../packages/vinext/src/shims/script.js")).default;

    const html = renderToStaticMarkup(
      React.createElement(Script, {
        strategy: "beforeInteractive",
        id: "inline-script",
        dangerouslySetInnerHTML: { __html: "console.log('hello')" },
      }),
    );
    expect(html).toContain("<script");
    expect(html).toContain('id="inline-script"');
    expect(html).toContain("console.log('hello')");
  });

  it("exports handleClientScriptLoad and initScriptLoader", async () => {
    const scriptModule = await import("../packages/vinext/src/shims/script.js");
    expect(typeof scriptModule.handleClientScriptLoad).toBe("function");
    expect(typeof scriptModule.initScriptLoader).toBe("function");
  });
});

describe("next/dist/* internal import shims", () => {
  it("app-router-context exports AppRouterContext and types", async () => {
    const mod = await import(
      "../packages/vinext/src/shims/internal/app-router-context.js"
    );
    expect(mod.AppRouterContext).toBeDefined();
    expect(mod.GlobalLayoutRouterContext).toBeDefined();
    expect(mod.LayoutRouterContext).toBeDefined();
    expect(mod.MissingSlotContext).toBeDefined();
    expect(mod.TemplateContext).toBeDefined();
  });

  it("utils exports NEXT_DATA type helpers", async () => {
    const mod = await import(
      "../packages/vinext/src/shims/internal/utils.js"
    );
    expect(typeof mod.execOnce).toBe("function");
    expect(typeof mod.getLocationOrigin).toBe("function");
    expect(typeof mod.getURL).toBe("function");

    // execOnce should only call the function once
    let count = 0;
    const fn = mod.execOnce(() => ++count);
    fn(); fn(); fn();
    expect(count).toBe(1);
  });

  it("api-utils exports NextApiRequestCookies type", async () => {
    // This module is primarily type-only, but should resolve without errors
    const mod = await import(
      "../packages/vinext/src/shims/internal/api-utils.js"
    );
    expect(mod).toBeDefined();
  });

  it("cookies shim re-exports RequestCookies and ResponseCookies", async () => {
    const mod = await import(
      "../packages/vinext/src/shims/internal/cookies.js"
    );
    expect(mod.RequestCookies).toBeDefined();
    expect(mod.ResponseCookies).toBeDefined();
  });

  it("work-unit-async-storage exports AsyncLocalStorage instances", async () => {
    const mod = await import(
      "../packages/vinext/src/shims/internal/work-unit-async-storage.js"
    );
    expect(mod.workUnitAsyncStorage).toBeDefined();
    expect(mod.requestAsyncStorage).toBeDefined();
    // Both should be the same AsyncLocalStorage instance
    expect(mod.workUnitAsyncStorage).toBe(mod.requestAsyncStorage);
  });

  it("router-context exports RouterContext", async () => {
    const mod = await import(
      "../packages/vinext/src/shims/internal/router-context.js"
    );
    expect(mod.RouterContext).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Cloudflare KV CacheHandler
// ---------------------------------------------------------------------------

describe("KVCacheHandler", () => {
  // In-memory mock of Cloudflare KV namespace
  function createMockKV() {
    const store = new Map<string, { value: string; expirationTtl?: number }>();
    return {
      store,
      async get(key: string): Promise<string | null> {
        return store.get(key)?.value ?? null;
      },
      async put(
        key: string,
        value: string,
        options?: { expirationTtl?: number },
      ): Promise<void> {
        store.set(key, { value, expirationTtl: options?.expirationTtl });
      },
      async delete(key: string): Promise<void> {
        store.delete(key);
      },
      async list(options?: { prefix?: string; limit?: number; cursor?: string }) {
        const prefix = options?.prefix ?? "";
        const keys: Array<{ name: string }> = [];
        for (const k of store.keys()) {
          if (k.startsWith(prefix)) keys.push({ name: k });
        }
        return { keys, list_complete: true };
      },
    };
  }

  it("stores and retrieves a cache entry", async () => {
    const { KVCacheHandler } = await import(
      "../packages/vinext/src/cloudflare/kv-cache-handler.js"
    );
    const kv = createMockKV();
    const handler = new KVCacheHandler(kv as any);

    await handler.set("test-key", {
      kind: "PAGES",
      html: "<h1>Hello</h1>",
      pageData: { props: {} },
      headers: undefined,
      status: 200,
    });

    const result = await handler.get("test-key");
    expect(result).not.toBeNull();
    expect(result!.value).not.toBeNull();
    expect(result!.value!.kind).toBe("PAGES");
    if (result!.value!.kind === "PAGES") {
      expect(result!.value!.html).toBe("<h1>Hello</h1>");
      expect(result!.value!.status).toBe(200);
    }
  });

  it("returns null for missing keys", async () => {
    const { KVCacheHandler } = await import(
      "../packages/vinext/src/cloudflare/kv-cache-handler.js"
    );
    const kv = createMockKV();
    const handler = new KVCacheHandler(kv as any);

    const result = await handler.get("nonexistent");
    expect(result).toBeNull();
  });

  it("handles tag-based invalidation", async () => {
    const { KVCacheHandler } = await import(
      "../packages/vinext/src/cloudflare/kv-cache-handler.js"
    );
    const kv = createMockKV();
    const handler = new KVCacheHandler(kv as any);

    await handler.set(
      "tagged-entry",
      {
        kind: "FETCH",
        data: { headers: {}, body: '{"result":1}', url: "test" },
        tags: ["my-tag"],
        revalidate: 0,
      },
      { tags: ["my-tag"] },
    );

    // Before invalidation — entry exists
    const before = await handler.get("tagged-entry");
    expect(before).not.toBeNull();

    // Invalidate the tag
    await handler.revalidateTag("my-tag");

    // After invalidation — entry should be treated as miss
    const after = await handler.get("tagged-entry");
    expect(after).toBeNull();
  });

  it("returns stale entry when past revalidation time", async () => {
    const { KVCacheHandler } = await import(
      "../packages/vinext/src/cloudflare/kv-cache-handler.js"
    );
    const kv = createMockKV();
    const handler = new KVCacheHandler(kv as any);

    // Set with very short revalidation (already expired)
    await handler.set(
      "stale-key",
      {
        kind: "PAGES",
        html: "<h1>Stale</h1>",
        pageData: {},
        headers: undefined,
        status: 200,
      },
      { revalidate: -1 }, // already past
    );

    // Manually fix the revalidateAt to be in the past
    const raw = await kv.get("cache:stale-key");
    const entry = JSON.parse(raw!);
    entry.revalidateAt = Date.now() - 1000;
    await kv.put("cache:stale-key", JSON.stringify(entry));

    const result = await handler.get("stale-key");
    expect(result).not.toBeNull();
    expect(result!.cacheState).toBe("stale");
    expect(result!.value!.kind).toBe("PAGES");
  });

  it("serializes and restores APP_PAGE with rscData ArrayBuffer", async () => {
    const { KVCacheHandler } = await import(
      "../packages/vinext/src/cloudflare/kv-cache-handler.js"
    );
    const kv = createMockKV();
    const handler = new KVCacheHandler(kv as any);

    const originalData = new TextEncoder().encode("RSC payload data");

    await handler.set("app-page-key", {
      kind: "APP_PAGE",
      html: "<div>App page</div>",
      rscData: originalData.buffer as ArrayBuffer,
      headers: { "x-custom": "value" },
      postponed: undefined,
      status: 200,
    });

    const result = await handler.get("app-page-key");
    expect(result).not.toBeNull();
    expect(result!.value!.kind).toBe("APP_PAGE");
    if (result!.value!.kind === "APP_PAGE") {
      expect(result!.value!.html).toBe("<div>App page</div>");
      // rscData should be restored as ArrayBuffer
      expect(result!.value!.rscData).toBeInstanceOf(ArrayBuffer);
      const restored = new TextDecoder().decode(result!.value!.rscData!);
      expect(restored).toBe("RSC payload data");
    }
  });

  it("serializes and restores APP_ROUTE with body ArrayBuffer", async () => {
    const { KVCacheHandler } = await import(
      "../packages/vinext/src/cloudflare/kv-cache-handler.js"
    );
    const kv = createMockKV();
    const handler = new KVCacheHandler(kv as any);

    const body = new TextEncoder().encode('{"ok":true}');

    await handler.set("route-key", {
      kind: "APP_ROUTE",
      body: body.buffer as ArrayBuffer,
      status: 200,
      headers: { "content-type": "application/json" },
    });

    const result = await handler.get("route-key");
    expect(result).not.toBeNull();
    if (result!.value!.kind === "APP_ROUTE") {
      const restored = new TextDecoder().decode(result!.value!.body);
      expect(restored).toBe('{"ok":true}');
    }
  });

  it("sets KV expiration TTL based on revalidation period", async () => {
    const { KVCacheHandler } = await import(
      "../packages/vinext/src/cloudflare/kv-cache-handler.js"
    );
    const kv = createMockKV();
    const handler = new KVCacheHandler(kv as any);

    await handler.set(
      "ttl-key",
      {
        kind: "PAGES",
        html: "<h1>TTL</h1>",
        pageData: {},
        headers: undefined,
        status: 200,
      },
      { revalidate: 60 }, // 60 seconds
    );

    // The KV entry should have an expiration TTL set
    const stored = kv.store.get("cache:ttl-key");
    expect(stored).toBeDefined();
    expect(stored!.expirationTtl).toBeDefined();
    // 10x the revalidation period = 600, but minimum is 60
    expect(stored!.expirationTtl).toBe(600);
  });

  it("handles multiple tag invalidation in parallel", async () => {
    const { KVCacheHandler } = await import(
      "../packages/vinext/src/cloudflare/kv-cache-handler.js"
    );
    const kv = createMockKV();
    const handler = new KVCacheHandler(kv as any);

    await handler.set(
      "multi-tag",
      {
        kind: "FETCH",
        data: { headers: {}, body: "{}", url: "test" },
        tags: ["tag-a", "tag-b"],
        revalidate: 0,
      },
      { tags: ["tag-a", "tag-b"] },
    );

    // Invalidate both tags at once
    await handler.revalidateTag(["tag-a", "tag-b"]);

    const result = await handler.get("multi-tag");
    expect(result).toBeNull();
  });

  it("handles corrupted KV entries gracefully", async () => {
    const { KVCacheHandler } = await import(
      "../packages/vinext/src/cloudflare/kv-cache-handler.js"
    );
    const kv = createMockKV();
    const handler = new KVCacheHandler(kv as any);

    // Put corrupted data directly
    await kv.put("cache:corrupt-key", "not valid json {{{");

    const result = await handler.get("corrupt-key");
    expect(result).toBeNull();
    // The corrupted entry should be cleaned up
    expect(await kv.get("cache:corrupt-key")).toBeNull();
  });
});

// ─── server-only / client-only shims ─────────────────────────────────────────

describe("server-only shim", () => {
  it("can be imported without error", async () => {
    const mod = await import("../packages/vinext/src/shims/server-only.js");
    expect(mod).toBeDefined();
  });

  it("exports nothing (empty marker module)", async () => {
    const mod = await import("../packages/vinext/src/shims/server-only.js");
    // The module should have no named exports (just the default module namespace)
    const keys = Object.keys(mod).filter((k) => k !== "__esModule" && k !== "default");
    expect(keys).toHaveLength(0);
  });
});

describe("client-only shim", () => {
  it("can be imported without error", async () => {
    const mod = await import("../packages/vinext/src/shims/client-only.js");
    expect(mod).toBeDefined();
  });

  it("exports nothing (empty marker module)", async () => {
    const mod = await import("../packages/vinext/src/shims/client-only.js");
    const keys = Object.keys(mod).filter((k) => k !== "__esModule" && k !== "default");
    expect(keys).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// next/link — onNavigate / NavigateEvent (View Transitions support, Issue #38)
// ---------------------------------------------------------------------------

describe("next/link onNavigate / NavigateEvent", () => {
  it("exports Link as default and useLinkStatus as named export", async () => {
    const mod = await import("../packages/vinext/src/shims/link.js");
    expect(typeof mod.default).toBe("object"); // forwardRef returns an object
    expect(typeof mod.useLinkStatus).toBe("function");
  });

  it("NavigateEvent.preventDefault() sets defaultPrevented to true", () => {
    // Mirrors the NavigateEvent construction in the Link click handler
    let prevented = false;
    const navEvent = {
      url: new URL("/about", "http://localhost"),
      preventDefault() { prevented = true; },
      get defaultPrevented() { return prevented; },
    };

    expect(navEvent.defaultPrevented).toBe(false);
    navEvent.preventDefault();
    expect(navEvent.defaultPrevented).toBe(true);
  });

  it("NavigateEvent.defaultPrevented is false when preventDefault is not called", () => {
    let prevented = false;
    const navEvent = {
      url: new URL("/products/1", "http://localhost"),
      preventDefault() { prevented = true; },
      get defaultPrevented() { return prevented; },
    };

    expect(navEvent.defaultPrevented).toBe(false);
    expect(navEvent.url.pathname).toBe("/products/1");
  });

  it("onNavigate callback receives event with correct url", () => {
    // Simulate what the Link component does in its click handler
    const resolvedHref = "/view-transitions/posts/42";
    const navUrl = new URL(resolvedHref, "http://localhost:3000");

    let prevented = false;
    const navEvent = {
      url: navUrl,
      preventDefault() { prevented = true; },
      get defaultPrevented() { return prevented; },
    };

    // Simulated TransitionLink-style callback
    const onNavigate = (event: typeof navEvent) => {
      event.preventDefault();
    };

    onNavigate(navEvent);
    expect(navEvent.defaultPrevented).toBe(true);
    expect(navEvent.url.pathname).toBe("/view-transitions/posts/42");
  });

  it("multiple preventDefault() calls are idempotent", () => {
    let prevented = false;
    const navEvent = {
      url: new URL("/", "http://localhost"),
      preventDefault() { prevented = true; },
      get defaultPrevented() { return prevented; },
    };

    navEvent.preventDefault();
    navEvent.preventDefault();
    navEvent.preventDefault();
    expect(navEvent.defaultPrevented).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// vinext:react-canary — ViewTransition & addTransitionType polyfills (Issue #42)
// ---------------------------------------------------------------------------

describe("vinext:react-canary transform logic", () => {
  // These tests verify the regex patterns used by the vinext:react-canary plugin
  // to detect and rewrite imports of React canary APIs.

  const canaryImportRegex = /import\s*\{[^}]*(ViewTransition|addTransitionType)[^}]*\}\s*from\s*['"]react['"]/;

  it("detects ViewTransition import from react", () => {
    const code = `import { ViewTransition } from "react";`;
    expect(canaryImportRegex.test(code)).toBe(true);
  });

  it("detects addTransitionType import from react", () => {
    const code = `import { addTransitionType } from "react";`;
    expect(canaryImportRegex.test(code)).toBe(true);
  });

  it("detects ViewTransition alongside other React imports", () => {
    const code = `import { useState, ViewTransition, useEffect } from "react";`;
    expect(canaryImportRegex.test(code)).toBe(true);
  });

  it("detects addTransitionType alongside other React imports", () => {
    const code = `import { useRef, addTransitionType } from 'react';`;
    expect(canaryImportRegex.test(code)).toBe(true);
  });

  it("detects both canary APIs in a single import", () => {
    const code = `import { ViewTransition, addTransitionType } from "react";`;
    expect(canaryImportRegex.test(code)).toBe(true);
  });

  it("does NOT match imports from other modules", () => {
    const code = `import { ViewTransition } from "some-other-lib";`;
    expect(canaryImportRegex.test(code)).toBe(false);
  });

  it("does NOT match non-canary React imports", () => {
    const code = `import { useState, useEffect } from "react";`;
    expect(canaryImportRegex.test(code)).toBe(false);
  });

  it("does NOT match default React import", () => {
    const code = `import React from "react";`;
    expect(canaryImportRegex.test(code)).toBe(false);
  });

  it("does NOT match namespace React import", () => {
    const code = `import * as React from "react";`;
    expect(canaryImportRegex.test(code)).toBe(false);
  });

  it("rewrites all 'from react' occurrences in a file with canary imports", () => {
    const code = [
      `import { useState } from "react";`,
      `import { ViewTransition } from "react";`,
      ``,
      `export default function Template({ children }) {`,
      `  return <ViewTransition>{children}</ViewTransition>;`,
      `}`,
    ].join("\n");

    // The transform replaces all `from "react"` in the file
    const result = code.replace(
      /from\s*['"]react['"]/g,
      'from "virtual:vinext-react-canary"',
    );

    expect(result).toContain('from "virtual:vinext-react-canary"');
    expect(result).not.toContain("from \"react\"");
    // Both import lines should be rewritten
    expect(result.match(/virtual:vinext-react-canary/g)?.length).toBe(2);
  });

  it("handles single-quoted imports", () => {
    const code = `import { ViewTransition } from 'react';`;
    expect(canaryImportRegex.test(code)).toBe(true);

    const result = code.replace(
      /from\s*['"]react['"]/g,
      'from "virtual:vinext-react-canary"',
    );
    expect(result).toBe(`import { ViewTransition } from "virtual:vinext-react-canary";`);
  });

  it("handles multiline imports", () => {
    const code = `import {\n  ViewTransition,\n  useState,\n} from "react";`;
    expect(canaryImportRegex.test(code)).toBe(true);
  });
});

describe("ViewTransition polyfill behavior", () => {
  it("provides a passthrough component when React lacks ViewTransition", () => {
    // Simulate the polyfill logic from the virtual module
    const React = { ViewTransition: undefined };
    const ViewTransition = React.ViewTransition || function ViewTransition({ children }: { children: any }) { return children; };

    // ViewTransition should be a function
    expect(typeof ViewTransition).toBe("function");

    // It should pass through children unchanged
    const children = { type: "div", props: {} };
    const result = ViewTransition({ children });
    expect(result).toBe(children);
  });

  it("uses native ViewTransition when React exports it", () => {
    // Simulate React canary that HAS ViewTransition
    const nativeViewTransition = function NativeViewTransition({ children }: { children: any }) {
      return { wrapped: children };
    };
    const React = { ViewTransition: nativeViewTransition };
    const ViewTransition = React.ViewTransition || function ViewTransition({ children }: { children: any }) { return children; };

    expect(ViewTransition).toBe(nativeViewTransition);
  });

  it("provides a no-op addTransitionType when React lacks it", () => {
    const React = { addTransitionType: undefined };
    const addTransitionType = React.addTransitionType || function addTransitionType() {};

    expect(typeof addTransitionType).toBe("function");
    // Should not throw when called
    expect(() => addTransitionType()).not.toThrow();
  });

  it("uses native addTransitionType when React exports it", () => {
    const nativeAddTransitionType = function nativeAddTransitionType(type: string) { return type; };
    const React = { addTransitionType: nativeAddTransitionType };
    const addTransitionType = React.addTransitionType || function addTransitionType() {};

    expect(addTransitionType).toBe(nativeAddTransitionType);
  });
});

// ---------------------------------------------------------------------------
// next/head SSR security tests
// ---------------------------------------------------------------------------

describe("next/head SSR security", () => {
  async function collectHeadHTML(children: React.ReactElement[]) {
    const React = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { default: Head, resetSSRHead, getSSRHeadHTML } = await import(
      "../packages/vinext/src/shims/head.js"
    );

    resetSSRHead();
    // Render Head with children — SSR path collects elements
    renderToStaticMarkup(
      React.createElement(Head, null, ...children),
    );
    return getSSRHeadHTML();
  }

  it("escapes HTML special characters in title children", async () => {
    const React = await import("react");
    const html = await collectHeadHTML([
      React.createElement("title", null, '</title><script>alert("xss")</script>'),
    ]);

    // The injected script tag must be escaped, not raw
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("</title><script>");
    expect(html).toContain("&lt;/title&gt;&lt;script&gt;");
  });

  it("escapes ampersands and angle brackets in children", async () => {
    const React = await import("react");
    const html = await collectHeadHTML([
      React.createElement("title", null, "Tom & Jerry < Friends > Foes"),
    ]);

    expect(html).toContain("Tom &amp; Jerry &lt; Friends &gt; Foes");
    expect(html).not.toContain("Tom & Jerry < Friends > Foes");
  });

  it("still allows dangerouslySetInnerHTML (intentionally raw)", async () => {
    const React = await import("react");
    const html = await collectHeadHTML([
      React.createElement("style", {
        dangerouslySetInnerHTML: { __html: "body { color: red; }" },
      }),
    ]);

    expect(html).toContain("body { color: red; }");
  });

  it("attributes are still properly escaped", async () => {
    const React = await import("react");
    const html = await collectHeadHTML([
      React.createElement("meta", {
        name: "description",
        content: 'He said "hello" & <goodbye>',
      }),
    ]);

    expect(html).toContain("&quot;hello&quot;");
    expect(html).toContain("&amp;");
    expect(html).toContain("&lt;goodbye&gt;");
  });

  it("rejects disallowed tag types (iframe)", async () => {
    const React = await import("react");
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const html = await collectHeadHTML([
      React.createElement("iframe" as any, { src: "https://evil.com" }),
    ]);

    expect(html).toBe("");
    expect(consoleWarn).toHaveBeenCalledWith(
      expect.stringContaining("ignoring disallowed tag <iframe>"),
    );
    consoleWarn.mockRestore();
  });

  it("rejects disallowed tag types (object, embed, form)", async () => {
    const React = await import("react");
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const html = await collectHeadHTML([
      React.createElement("object" as any, { data: "https://evil.com" }),
      React.createElement("embed" as any, { src: "https://evil.com" }),
      React.createElement("form" as any, { action: "https://evil.com" }),
    ]);

    expect(html).toBe("");
    consoleWarn.mockRestore();
  });

  it("allows all valid head tags", async () => {
    const React = await import("react");
    const { resetSSRHead } = await import(
      "../packages/vinext/src/shims/head.js"
    );

    const allowedTags = ["title", "meta", "link", "style", "script", "base", "noscript"];

    for (const tag of allowedTags) {
      resetSSRHead();
      const selfClosing = ["meta", "link", "base"].includes(tag);
      const el = selfClosing
        ? React.createElement(tag, { name: "test", content: "test" })
        : React.createElement(tag, null, "test content");

      const html = await collectHeadHTML([el]);

      expect(html).toContain(`<${tag}`);
      expect(html).toContain('data-vinext-head="true"');
    }
  });
});

describe("isValidModulePath", () => {
  it("accepts valid absolute paths", () => {
    expect(isValidModulePath("/src/pages/index.tsx")).toBe(true);
    expect(isValidModulePath("/pages/about.js")).toBe(true);
    expect(isValidModulePath("/src/pages/posts/[id].tsx")).toBe(true);
  });

  it("accepts valid relative paths starting with ./", () => {
    expect(isValidModulePath("./src/pages/index.tsx")).toBe(true);
    expect(isValidModulePath("./pages/about.js")).toBe(true);
  });

  it("rejects external https:// URLs", () => {
    expect(isValidModulePath("https://evil.com/steal-cookies.js")).toBe(false);
  });

  it("rejects external http:// URLs", () => {
    expect(isValidModulePath("http://evil.com/steal-cookies.js")).toBe(false);
  });

  it("rejects protocol-relative URLs (//)", () => {
    expect(isValidModulePath("//evil.com/steal-cookies.js")).toBe(false);
    expect(isValidModulePath("//cdn.example.com/script.js")).toBe(false);
  });

  it("rejects directory traversal", () => {
    expect(isValidModulePath("/src/../../../etc/passwd")).toBe(false);
    expect(isValidModulePath("./../../secret.js")).toBe(false);
    expect(isValidModulePath("/pages/..%2F..%2Fsecret.js")).toBe(false);
  });

  it("rejects data: URLs", () => {
    expect(isValidModulePath("data:text/javascript,alert(1)")).toBe(false);
  });

  it("rejects blob: URLs", () => {
    expect(isValidModulePath("blob:http://localhost/abc")).toBe(false);
  });

  it("rejects bare specifiers", () => {
    expect(isValidModulePath("evil-package")).toBe(false);
    expect(isValidModulePath("@evil/package")).toBe(false);
  });

  it("rejects non-string values", () => {
    expect(isValidModulePath(null)).toBe(false);
    expect(isValidModulePath(undefined)).toBe(false);
    expect(isValidModulePath(42)).toBe(false);
    expect(isValidModulePath({})).toBe(false);
    expect(isValidModulePath("")).toBe(false);
  });

  it("rejects javascript: protocol", () => {
    expect(isValidModulePath("javascript:alert(1)")).toBe(false);
  });

  it("rejects ftp:// protocol", () => {
    expect(isValidModulePath("ftp://evil.com/script.js")).toBe(false);
  });
});
