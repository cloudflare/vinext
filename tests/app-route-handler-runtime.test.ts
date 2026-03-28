import { describe, expect, it } from "vite-plus/test";
import {
  buildRouteHandlerAllowHeader,
  collectRouteHandlerMethods,
  createTrackedAppRouteRequest,
  isKnownDynamicAppRoute,
  markKnownDynamicAppRoute,
} from "../packages/vinext/src/server/app-route-handler-runtime.js";

describe("app route handler runtime helpers", () => {
  it("collects exported route handler methods and auto-adds HEAD for GET", () => {
    const methods = collectRouteHandlerMethods({
      GET() {},
      POST() {},
      default() {},
    });

    expect(methods).toEqual(["GET", "POST", "HEAD"]);
    expect(buildRouteHandlerAllowHeader(methods)).toBe("GET, HEAD, OPTIONS, POST");
  });

  it("tracks direct request.headers access", () => {
    const accesses: string[] = [];
    const tracked = createTrackedAppRouteRequest(
      new Request("https://example.com/demo", {
        headers: { "x-test-ping": "pong" },
      }),
      {
        onDynamicAccess(access) {
          accesses.push(access);
        },
      },
    );

    expect(tracked.request.headers.get("x-test-ping")).toBe("pong");
    expect(tracked.didAccessDynamicRequest()).toBe(true);
    expect(accesses).toEqual(["request.headers"]);
  });

  it("tracks request.url access for query parsing", () => {
    const accesses: string[] = [];
    const tracked = createTrackedAppRouteRequest(
      new Request("https://example.com/demo?ping=from-url"),
      {
        onDynamicAccess(access) {
          accesses.push(access);
        },
      },
    );

    const url = new URL(tracked.request.url);

    expect(url.searchParams.get("ping")).toBe("from-url");
    expect(tracked.didAccessDynamicRequest()).toBe(true);
    expect(accesses).toEqual(["request.url"]);
  });

  it("tracks dynamic nextUrl fields but not pathname", () => {
    const accesses: string[] = [];
    const tracked = createTrackedAppRouteRequest(
      new Request("https://example.com/base/fr/demo?ping=from-next-url"),
      {
        basePath: "/base",
        i18n: { locales: ["en", "fr"], defaultLocale: "en" },
        onDynamicAccess(access) {
          accesses.push(access);
        },
      },
    );

    expect(tracked.request.nextUrl.pathname).toBe("/demo");
    expect(tracked.request.nextUrl.locale).toBe("fr");
    expect(tracked.didAccessDynamicRequest()).toBe(false);

    expect(tracked.request.nextUrl.searchParams.get("ping")).toBe("from-next-url");
    expect(tracked.request.nextUrl.href).toBe(
      "https://example.com/base/fr/demo?ping=from-next-url",
    );
    expect(accesses).toEqual(["nextUrl.searchParams", "nextUrl.href"]);
    expect(tracked.didAccessDynamicRequest()).toBe(true);
  });

  it("tracks body-reading request methods without breaking Request internals", async () => {
    const accesses: string[] = [];
    const tracked = createTrackedAppRouteRequest(
      new Request("https://example.com/demo", {
        method: "POST",
        body: JSON.stringify({ ok: true }),
        headers: { "content-type": "application/json" },
      }),
      {
        onDynamicAccess(access) {
          accesses.push(access);
        },
      },
    );

    expect(tracked.request instanceof Request).toBe(true);
    expect(tracked.request.method).toBe("POST");
    expect(tracked.request.clone().headers.get("content-type")).toBe("application/json");
    await expect(tracked.request.json()).resolves.toEqual({ ok: true });
    expect(accesses).toEqual(["request.headers", "request.json"]);
  });

  it("remembers known dynamic app routes for the process lifetime", () => {
    const pattern = "/tests/app-route-handler-runtime/" + Date.now();

    expect(isKnownDynamicAppRoute(pattern)).toBe(false);
    markKnownDynamicAppRoute(pattern);
    expect(isKnownDynamicAppRoute(pattern)).toBe(true);
  });
});
