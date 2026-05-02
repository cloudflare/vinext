import { describe, expect, it } from "vite-plus/test";
import {
  buildRouteHandlerAllowHeader,
  collectRouteHandlerMethods,
  createTrackedAppRouteRequest,
  isKnownDynamicAppRoute,
  markKnownDynamicAppRoute,
} from "../packages/vinext/src/server/app-route-handler-runtime.js";
import { NextRequest, NextURL } from "../packages/vinext/src/shims/server.js";

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

  it("stubs request-specific fields for force-static route handlers", () => {
    const accesses: string[] = [];
    const options = {
      basePath: "",
      requestMode: "force-static" as const,
      onDynamicAccess(access: string) {
        accesses.push(access);
      },
    };
    const tracked = createTrackedAppRouteRequest(
      new Request("https://tenant.example.com/demo?secret=from-user", {
        headers: {
          "cf-connecting-ip": "203.0.113.10",
          "cf-ipcountry": "AU",
          cookie: "session=abc",
          "x-test-ping": "pong",
        },
      }),
      options,
    );

    expect(tracked.request.headers.get("x-test-ping")).toBeNull();
    expect(typeof tracked.request.headers.set).toBe("function");
    expect(() => tracked.request.headers.set("x-test-ping", "mutated")).toThrow(
      "Headers cannot be modified",
    );
    expect(tracked.request.headers.get("x-test-ping")).toBeNull();
    expect(tracked.request.cookies.get("session")).toBeUndefined();
    expect(tracked.request.ip).toBeUndefined();
    expect(tracked.request.geo).toBeUndefined();
    expect(tracked.request.url).toBe("http://localhost:3000/demo");
    expect(tracked.request.nextUrl.href).toBe("http://localhost:3000/demo");
    expect(tracked.request.nextUrl.search).toBe("");
    expect(tracked.request.nextUrl.searchParams.get("secret")).toBeNull();
    expect(tracked.didAccessDynamicRequest()).toBe(false);
    expect(accesses).toEqual([]);
  });

  it("removes credentials from force-static route handler URLs", () => {
    const request = new NextRequest("https://tenant.example.com/demo");
    Object.defineProperty(request, "nextUrl", {
      configurable: true,
      value: new NextURL("https://user:pass@tenant.example.com/demo?secret=from-user#fragment"),
    });
    const tracked = createTrackedAppRouteRequest(request, {
      requestMode: "force-static",
    });

    expect(tracked.request.url).toBe("http://localhost:3000/demo");
    expect(tracked.request.nextUrl.href).toBe("http://localhost:3000/demo");
  });

  it("stubs body-reading APIs for force-static route handlers", async () => {
    const accesses: string[] = [];
    const createTrackedPost = () =>
      createTrackedAppRouteRequest(
        new Request("https://example.com/demo", {
          method: "POST",
          body: JSON.stringify({ secret: "from-user" }),
          headers: { "content-type": "application/json" },
        }),
        {
          requestMode: "force-static",
          onDynamicAccess(access) {
            accesses.push(access);
          },
        },
      );

    expect(createTrackedPost().request.body).toBeNull();
    await expect(createTrackedPost().request.text()).resolves.toBe("");
    await expect(createTrackedPost().request.arrayBuffer()).resolves.toHaveProperty(
      "byteLength",
      0,
    );
    await expect(createTrackedPost().request.blob()).resolves.toHaveProperty("size", 0);
    await expect(createTrackedPost().request.json()).rejects.toThrow();
    await expect(createTrackedPost().request.formData()).rejects.toThrow();
    expect(accesses).toEqual([]);
  });

  it("seals force-static route handler request cookies", () => {
    const tracked = createTrackedAppRouteRequest(new Request("https://example.com/demo"), {
      requestMode: "force-static",
    });

    expect(typeof tracked.request.cookies.set).toBe("function");
    expect(typeof tracked.request.cookies.delete).toBe("function");
    expect(typeof tracked.request.cookies.clear).toBe("function");
    expect(() => tracked.request.cookies.set("session", "abc")).toThrow(
      "Cookies can only be modified",
    );
    expect(() => tracked.request.cookies.delete("session")).toThrow("Cookies can only be modified");
    expect(() => tracked.request.cookies.clear()).toThrow("Cookies can only be modified");
  });

  it("throws on dynamic request access for dynamic error route handlers", () => {
    const expectedMessage = (expression?: string): string =>
      `Route /private with \`dynamic = "error"\` couldn't be rendered statically because it used ${expression ?? "a dynamic request API"}. See more info here: https://nextjs.org/docs/app/building-your-application/rendering/static-and-dynamic#dynamic-rendering`;
    const tracked = createTrackedAppRouteRequest(
      new Request("https://example.com/private?token=secret", {
        method: "POST",
        body: "payload",
      }),
      {
        requestMode: "error",
        staticGenerationErrorMessage: expectedMessage,
      },
    );

    expect(() => tracked.request.headers).toThrow(expectedMessage("request.headers"));
    expect(() => tracked.request.cookies).toThrow(expectedMessage("request.cookies"));
    expect(() => tracked.request.url).toThrow(expectedMessage("request.url"));
    expect(() => tracked.request.ip).toThrow(expectedMessage("request.ip"));
    expect(() => tracked.request.geo).toThrow(expectedMessage("request.geo"));
    expect(() => Reflect.get(tracked.request, "body")).toThrow(expectedMessage("request.body"));
    expect(() => Reflect.get(tracked.request, "blob")).toThrow(expectedMessage("request.blob"));
    expect(() => Reflect.get(tracked.request, "json")).toThrow(expectedMessage("request.json"));
    expect(() => Reflect.get(tracked.request, "text")).toThrow(expectedMessage("request.text"));
    expect(() => Reflect.get(tracked.request, "arrayBuffer")).toThrow(
      expectedMessage("request.arrayBuffer"),
    );
    expect(() => Reflect.get(tracked.request, "formData")).toThrow(
      expectedMessage("request.formData"),
    );

    expect(() => tracked.request.nextUrl.search).toThrow(expectedMessage("nextUrl.search"));
    expect(() => tracked.request.nextUrl.searchParams).toThrow(
      expectedMessage("nextUrl.searchParams"),
    );
    expect(() => tracked.request.nextUrl.href).toThrow(expectedMessage("nextUrl.href"));
    expect(() => tracked.request.nextUrl.origin).toThrow(expectedMessage("nextUrl.origin"));
    expect(() => Reflect.get(tracked.request.nextUrl, "toString")).toThrow(
      expectedMessage("nextUrl.toString"),
    );

    const clonedRequest = tracked.request.clone();
    expect(() => clonedRequest.headers).toThrow(expectedMessage("request.headers"));

    const clonedNextUrl = tracked.request.nextUrl.clone();
    expect(() => clonedNextUrl.search).toThrow(expectedMessage("nextUrl.search"));
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

  it("normalizes request.url through nextUrl for stripped internal app route requests", () => {
    const tracked = createTrackedAppRouteRequest(
      new Request("https://example.com/fr/demo?ping=from-url"),
      {
        basePath: "/base",
        i18n: { locales: ["en", "fr"], defaultLocale: "en" },
      },
    );

    expect(tracked.request.nextUrl.href).toBe("https://example.com/base/fr/demo?ping=from-url");
    expect(tracked.request.url).toBe("https://example.com/base/fr/demo?ping=from-url");
  });

  it("tracks request.ip and request.geo access", () => {
    const accesses: string[] = [];
    const tracked = createTrackedAppRouteRequest(
      new Request("https://example.com/demo", {
        headers: {
          "cf-connecting-ip": "203.0.113.10",
          "cf-ipcountry": "AU",
        },
      }),
      {
        onDynamicAccess(access) {
          accesses.push(access);
        },
      },
    );

    expect(tracked.request.ip).toBe("203.0.113.10");
    expect(tracked.request.geo).toEqual({ country: "AU" });
    expect(tracked.didAccessDynamicRequest()).toBe(true);
    expect(accesses).toEqual(["request.ip", "request.geo"]);
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
