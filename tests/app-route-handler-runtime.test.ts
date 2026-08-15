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
    await expect(createTrackedPost().request.bytes()).resolves.toHaveLength(0);
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
    expect(() => Reflect.get(tracked.request, "bytes")).toThrow(expectedMessage("request.bytes"));
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
    // The App Router routing layer strips basePath before route handlers run,
    // so createTrackedAppRouteRequest re-adds the configured prefix. Route
    // handlers then observe the original URL Next.js would hand them:
    // request.url / nextUrl.href carry the basePath prefix, while
    // nextUrl.pathname stays basePath- and locale-free and nextUrl.basePath
    // reports the configured value (getNextPathnameInfo semantics).
    const tracked = createTrackedAppRouteRequest(
      new Request("https://example.com/fr/demo?ping=from-url"),
      {
        basePath: "/base",
        i18n: { locales: ["en", "fr"], defaultLocale: "en" },
      },
    );

    expect(tracked.request.nextUrl.basePath).toBe("/base");
    expect(tracked.request.nextUrl.pathname).toBe("/demo");
    expect(tracked.request.nextUrl.href).toBe("https://example.com/base/fr/demo?ping=from-url");
    expect(tracked.request.url).toBe("https://example.com/base/fr/demo?ping=from-url");
  });

  it("transfers the request body when re-adding basePath instead of teeing it", async () => {
    const request = new Request("https://example.com/demo", {
      body: JSON.stringify({ ok: true }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    const tracked = createTrackedAppRouteRequest(request, { basePath: "/base" });

    await expect(tracked.request.json()).resolves.toEqual({ ok: true });
    // Cloning to re-add the prefix would tee the body, and the branch left on
    // the incoming request buffers the whole upload in memory because nothing
    // reads or cancels it.
    expect(request.bodyUsed).toBe(true);
  });

  it("preserves Workers cf metadata when re-adding basePath", () => {
    const request = new Request("https://example.com/demo");
    const cf = { country: "AU" };
    Object.defineProperty(request, "cf", { value: cf, enumerable: true });

    const tracked = createTrackedAppRouteRequest(request, { basePath: "/base" });

    expect(tracked.request.url).toBe("https://example.com/base/demo");
    expect(Reflect.get(tracked.request, "cf")).toBe(cf);
  });

  it("preserves Workers cf metadata when applying middleware request headers", () => {
    const request = new Request("https://example.com/demo");
    const cf = { country: "AU" };
    Object.defineProperty(request, "cf", { value: cf, enumerable: true });

    const tracked = createTrackedAppRouteRequest(request, {
      middlewareHeaders: new Headers({
        "x-middleware-override-headers": "x-added",
        "x-middleware-request-x-added": "from-middleware",
      }),
    });

    expect(tracked.request.headers.get("x-added")).toBe("from-middleware");
    expect(Reflect.get(tracked.request, "cf")).toBe(cf);
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

  it("treats request.cf as dynamic request state", () => {
    const cf = { country: "AU" };
    const createRequest = () => {
      const request = new Request("https://example.com/demo");
      Object.defineProperty(request, "cf", { value: cf, enumerable: true });
      return request;
    };
    const accesses: string[] = [];
    const tracked = createTrackedAppRouteRequest(createRequest(), {
      onDynamicAccess(access) {
        accesses.push(access);
      },
    });

    expect(Reflect.get(tracked.request, "cf")).toBe(cf);
    expect(tracked.didAccessDynamicRequest()).toBe(true);
    expect(accesses).toEqual(["request.cf"]);

    const absentAccesses: string[] = [];
    const withoutCf = createTrackedAppRouteRequest(new Request("https://example.com/demo"), {
      onDynamicAccess(access) {
        absentAccesses.push(access);
      },
    });
    expect(Reflect.get(withoutCf.request, "cf")).toBeUndefined();
    expect(withoutCf.didAccessDynamicRequest()).toBe(true);
    expect(absentAccesses).toEqual(["request.cf"]);

    const forceStatic = createTrackedAppRouteRequest(createRequest(), {
      requestMode: "force-static",
    });
    expect(Reflect.get(forceStatic.request, "cf")).toBeUndefined();
    expect(forceStatic.didAccessDynamicRequest()).toBe(false);

    const dynamicError = createTrackedAppRouteRequest(createRequest(), {
      requestMode: "error",
      staticGenerationErrorMessage: (expression) => `dynamic access: ${expression}`,
    });
    expect(() => Reflect.get(dynamicError.request, "cf")).toThrow("dynamic access: request.cf");
  });

  it("preserves Workers cf metadata when cloning tracked requests", () => {
    const request = new Request("https://example.com/demo");
    const cf = { country: "AU" };
    Object.defineProperty(request, "cf", { value: cf, enumerable: true });
    const accesses: string[] = [];
    const tracked = createTrackedAppRouteRequest(request, {
      onDynamicAccess(access) {
        accesses.push(access);
      },
    });

    const cloned = tracked.request.clone();

    expect(Reflect.get(cloned, "cf")).toBe(cf);
    expect(tracked.didAccessDynamicRequest()).toBe(true);
    expect(accesses).toEqual(["request.cf"]);
  });

  it("applies request.cf policy to reflective access", () => {
    const createRequest = (withCf: boolean) => {
      const request = new Request("https://example.com/demo");
      if (withCf) {
        Object.defineProperty(request, "cf", {
          value: { country: "AU" },
          enumerable: true,
          configurable: true,
        });
      }
      return request;
    };
    const reads = [
      (request: NextRequest) => "cf" in request,
      (request: NextRequest) => Object.hasOwn(request, "cf"),
      (request: NextRequest) => request.hasOwnProperty("cf"),
      (request: NextRequest) => request.propertyIsEnumerable("cf"),
      (request: NextRequest) => Object.getOwnPropertyDescriptor(request, "cf") !== undefined,
    ];

    for (const withCf of [false, true]) {
      for (const read of reads) {
        const tracked = createTrackedAppRouteRequest(createRequest(withCf));
        expect(read(tracked.request)).toBe(withCf);
        expect(tracked.didAccessDynamicRequest()).toBe(true);

        const forceStatic = createTrackedAppRouteRequest(createRequest(withCf), {
          requestMode: "force-static",
        });
        expect(read(forceStatic.request)).toBe(false);
        expect(forceStatic.didAccessDynamicRequest()).toBe(false);

        const dynamicError = createTrackedAppRouteRequest(createRequest(withCf), {
          requestMode: "error",
          staticGenerationErrorMessage: (expression) => `dynamic access: ${expression}`,
        });
        expect(() => read(dynamicError.request)).toThrow("dynamic access: request.cf");
      }
    }

    const withCf = createTrackedAppRouteRequest(createRequest(true));
    expect(Object.keys(withCf.request)).toContain("cf");
    expect(withCf.didAccessDynamicRequest()).toBe(true);

    const withoutCf = createTrackedAppRouteRequest(createRequest(false));
    expect(Object.keys(withoutCf.request)).not.toContain("cf");
    expect(withoutCf.didAccessDynamicRequest()).toBe(true);

    const absentDynamicError = createTrackedAppRouteRequest(createRequest(false), {
      requestMode: "error",
      staticGenerationErrorMessage: (expression) => `dynamic access: ${expression}`,
    });
    expect(() => Object.keys(absentDynamicError.request)).toThrow("dynamic access: request.cf");
  });

  it("keeps Object helpers inside the tracked request proxy", () => {
    const request = new Request("https://example.com/demo");
    const cf = { country: "AU" };
    Object.defineProperty(request, "cf", { value: cf, configurable: true });
    const tracked = createTrackedAppRouteRequest(request);

    expect(tracked.request.valueOf()).toBe(tracked.request);
    expect(Reflect.get(tracked.request.valueOf(), "cf")).toBe(cf);
    expect(tracked.didAccessDynamicRequest()).toBe(true);
  });

  it("keeps request.cf deletion and redefinition coherent", () => {
    const request = new Request("https://example.com/demo");
    Object.defineProperty(request, "cf", {
      value: { country: "AU" },
      enumerable: true,
      configurable: true,
    });
    const tracked = createTrackedAppRouteRequest(request);

    expect(Reflect.deleteProperty(tracked.request, "cf")).toBe(true);
    expect(Reflect.get(tracked.request, "cf")).toBeUndefined();

    const replacement = { country: "GB" };
    Object.defineProperty(tracked.request, "cf", {
      value: replacement,
      enumerable: true,
      configurable: true,
    });
    expect(Reflect.get(tracked.request, "cf")).toBe(replacement);
    expect(Reflect.get(tracked.request.valueOf(), "cf")).toBe(replacement);

    Object.defineProperty(tracked.request, "cf", {
      configurable: true,
      get() {
        return this;
      },
    });
    expect(Reflect.get(tracked.request, "cf")).toBe(tracked.request);
  });

  it("keeps request extensions on the tracked proxy receiver", () => {
    const createRequest = () => {
      const request = new Request("https://example.com/demo");
      Object.defineProperty(request, "cf", {
        value: { country: "AU" },
        configurable: true,
      });
      return request;
    };
    const extend = (request: NextRequest) => {
      const extended = request as NextRequest & { raw: NextRequest; unwrap(): NextRequest };
      Object.defineProperties(extended, {
        raw: {
          configurable: true,
          get() {
            return this;
          },
        },
        unwrap: {
          configurable: true,
          value() {
            return this;
          },
        },
      });
      return extended;
    };

    const tracked = createTrackedAppRouteRequest(createRequest());
    const extended = extend(tracked.request);
    expect(extended.raw).toBe(tracked.request);
    expect(extended.unwrap()).toBe(tracked.request);
    expect(Reflect.get(extended.unwrap(), "cf")).toEqual({ country: "AU" });
    expect(tracked.didAccessDynamicRequest()).toBe(true);

    const forceStatic = extend(
      createTrackedAppRouteRequest(createRequest(), { requestMode: "force-static" }).request,
    );
    expect(Reflect.get(forceStatic.unwrap(), "cf")).toBeUndefined();

    const dynamicError = extend(
      createTrackedAppRouteRequest(createRequest(), {
        requestMode: "error",
        staticGenerationErrorMessage: (expression) => `dynamic access: ${expression}`,
      }).request,
    );
    expect(() => Reflect.get(dynamicError.raw, "cf")).toThrow("dynamic access: request.cf");
  });

  it("keeps pre-wrap Request prototype shadows on the tracked receiver", () => {
    const originalMethod = Object.getOwnPropertyDescriptor(Request.prototype, "method");
    Object.defineProperty(Request.prototype, "method", {
      configurable: true,
      get() {
        return this;
      },
    });
    const createRequest = () => {
      const request = new Request("https://example.com/demo");
      Object.defineProperty(request, "cf", {
        value: { country: "AU" },
        configurable: true,
      });
      return request;
    };

    try {
      const tracked = createTrackedAppRouteRequest(createRequest());
      expect(Reflect.get(tracked.request, "method")).toBe(tracked.request);
      expect(
        Reflect.get(Reflect.get(tracked.request, "method") as unknown as object, "cf"),
      ).toEqual({
        country: "AU",
      });
      expect(tracked.didAccessDynamicRequest()).toBe(true);

      const forceStatic = createTrackedAppRouteRequest(createRequest(), {
        requestMode: "force-static",
      });
      expect(
        Reflect.get(Reflect.get(forceStatic.request, "method") as unknown as object, "cf"),
      ).toBeUndefined();

      const dynamicError = createTrackedAppRouteRequest(createRequest(), {
        requestMode: "error",
        staticGenerationErrorMessage: (expression) => `dynamic access: ${expression}`,
      });
      expect(() =>
        Reflect.get(Reflect.get(dynamicError.request, "method") as unknown as object, "cf"),
      ).toThrow("dynamic access: request.cf");
    } finally {
      if (originalMethod) Object.defineProperty(Request.prototype, "method", originalMethod);
    }
  });

  it("keeps delegating wrappers around Request accessors brand-safe", () => {
    const originalMethod = Object.getOwnPropertyDescriptor(Request.prototype, "method");
    Object.defineProperty(Request.prototype, "method", {
      configurable: true,
      get(this: Request) {
        return originalMethod?.get?.call(this);
      },
    });

    try {
      const request = new Request("https://example.com/demo");
      Object.defineProperty(request, "cf", {
        value: { country: "AU" },
        configurable: true,
      });
      const tracked = createTrackedAppRouteRequest(request);

      expect(tracked.request.method).toBe("GET");
      expect(tracked.didAccessDynamicRequest()).toBe(true);
    } finally {
      if (originalMethod) Object.defineProperty(Request.prototype, "method", originalMethod);
    }
  });

  it("keeps the force-static target policy-safe for branded accessor wrappers", () => {
    const originalMethod = Object.getOwnPropertyDescriptor(Request.prototype, "method");
    Object.defineProperty(Request.prototype, "method", {
      configurable: true,
      get(this: Request) {
        return `${this.url}|${this.headers.get("x-secret") ?? ""}`;
      },
    });

    try {
      for (const withCf of [false, true]) {
        const request = new Request("https://example.com/demo", {
          headers: { "x-secret": "should-not-leak" },
        });
        if (withCf) {
          Object.defineProperty(request, "cf", {
            value: { country: "AU" },
            configurable: true,
          });
        }
        const tracked = createTrackedAppRouteRequest(request, {
          requestMode: "force-static",
        });

        expect(tracked.request.method).toBe("http://localhost:3000/demo|");
        expect(tracked.didAccessDynamicRequest()).toBe(false);
      }
    } finally {
      if (originalMethod) Object.defineProperty(Request.prototype, "method", originalMethod);
    }
  });

  it("keeps pre-wrap wrappers around dynamic Request methods brand-safe", async () => {
    const originalText = Object.getOwnPropertyDescriptor(Request.prototype, "text");
    const text = originalText?.value as (this: Request) => Promise<string>;
    Object.defineProperty(Request.prototype, "text", {
      configurable: true,
      value(this: Request) {
        return text.call(this);
      },
    });

    try {
      const tracked = createTrackedAppRouteRequest(
        new Request("https://example.com/demo", { method: "POST", body: "payload" }),
      );
      await expect(tracked.request.text()).resolves.toBe("payload");
      expect(tracked.didAccessDynamicRequest()).toBe(true);
    } finally {
      if (originalText) Object.defineProperty(Request.prototype, "text", originalText);
    }
  });

  it("tracks Request.bytes wrappers with a branded receiver", async () => {
    const originalBytes = Object.getOwnPropertyDescriptor(Request.prototype, "bytes");
    const bytes = originalBytes?.value as (this: Request) => Promise<Uint8Array>;
    Object.defineProperty(Request.prototype, "bytes", {
      configurable: true,
      value(this: Request) {
        return bytes.call(this);
      },
    });

    try {
      const tracked = createTrackedAppRouteRequest(
        new Request("https://example.com/demo", { method: "POST", body: "payload" }),
      );
      await expect(tracked.request.bytes()).resolves.toEqual(new TextEncoder().encode("payload"));
      expect(tracked.didAccessDynamicRequest()).toBe(true);
    } finally {
      if (originalBytes) Object.defineProperty(Request.prototype, "bytes", originalBytes);
    }
  });

  it("preserves request.cf data descriptors while tracking access", () => {
    const request = new Request("https://example.com/demo");
    const cf = { country: "AU" };
    Object.defineProperty(request, "cf", {
      value: cf,
      enumerable: true,
      configurable: true,
    });
    const tracked = createTrackedAppRouteRequest(request);

    expect(Object.getOwnPropertyDescriptor(tracked.request, "cf")?.value).toBe(cf);
    expect(tracked.didAccessDynamicRequest()).toBe(true);
  });

  it("applies partial request.cf descriptor updates to the visible data property", () => {
    const cf = { country: "AU" };
    const createTracked = (requestMode: "auto" | "error" = "auto") => {
      const request = new Request("https://example.com/demo");
      Object.defineProperty(request, "cf", {
        value: cf,
        enumerable: true,
        configurable: true,
      });
      return createTrackedAppRouteRequest(request, {
        requestMode,
        staticGenerationErrorMessage: (expression) => `dynamic access: ${expression}`,
      });
    };

    const writable = createTracked();
    Object.defineProperty(writable.request, "cf", { writable: true });
    expect(Object.getOwnPropertyDescriptor(writable.request, "cf")).toMatchObject({
      value: cf,
      writable: true,
    });

    const locked = createTracked();
    Object.defineProperty(locked.request, "cf", { configurable: false });
    expect(Object.getOwnPropertyDescriptor(locked.request, "cf")).toMatchObject({
      configurable: false,
      value: cf,
    });

    const dynamicError = createTracked("error");
    expect(() => Object.defineProperty(dynamicError.request, "cf", { writable: true })).toThrow(
      "dynamic access: request.cf",
    );
  });

  it("normalizes non-configurable request.cf before force-static tracking", () => {
    const request = new NextRequest("https://example.com/demo");
    Object.defineProperty(request, "cf", {
      value: { country: "AU" },
      enumerable: true,
      configurable: false,
    });

    const tracked = createTrackedAppRouteRequest(request, { requestMode: "force-static" });

    expect(Reflect.get(tracked.request, "cf")).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(tracked.request, "cf")).toBeUndefined();
    expect(Reflect.ownKeys(tracked.request)).not.toContain("cf");
  });

  it("keeps force-static request.cf hidden after integrity operations", () => {
    for (const lock of [Object.preventExtensions, Object.seal, Object.freeze]) {
      const request = new Request("https://example.com/demo");
      Object.defineProperty(request, "cf", {
        value: { country: "AU" },
        enumerable: true,
        configurable: true,
      });
      const tracked = createTrackedAppRouteRequest(request, { requestMode: "force-static" });

      expect(() => lock(tracked.request)).not.toThrow();
      expect(Reflect.ownKeys(tracked.request)).not.toContain("cf");
      expect(Object.getOwnPropertyDescriptor(tracked.request, "cf")).toBeUndefined();
      expect("cf" in tracked.request).toBe(false);
    }
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
