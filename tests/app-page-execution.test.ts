import { describe, expect, it, vi } from "vite-plus/test";
import {
  APP_PAGE_NOT_FOUND_BOUNDARY_ID,
  buildAppPageFontLinkHeader,
  buildAppPageSpecialErrorResponse,
  bufferAppPageBinaryStream,
  resolveAppPageCaughtNotFoundBoundaries,
  resolveAppPageShellSpecialError,
  resolveAppPageSpecialError,
  tagAppPageLayoutError,
  tagAppPagePageError,
  tagAppPageSlotError,
  teeAppPageRscStreamForCapture,
} from "../packages/vinext/src/server/app-page-execution.js";
import { parseNextRedirectDigest } from "../packages/vinext/src/server/next-error-digest.js";
import { notFound } from "../packages/vinext/src/shims/navigation-errors.js";
import { readStreamAsText } from "../packages/vinext/src/utils/text-stream.js";
import {
  hasFrameworkLinkHeaders,
  markFrameworkLinkHeaders,
} from "../packages/vinext/src/server/app-response-header-provenance.js";
import {
  VINEXT_RSC_BUILD_ID_HEADER,
  VINEXT_RSC_COMPATIBILITY_ID_HEADER,
} from "../packages/vinext/src/server/app-rsc-cache-busting.js";
import { withEnvVar } from "./env-test-helpers.js";

function createStream(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(new TextEncoder().encode(chunk));
      }
      controller.close();
    },
  });
}

function createMiddlewareContext() {
  const headers = new Headers();
  headers.set("x-middleware-security", "present");
  headers.append("set-cookie", "session=rotated; Path=/; HttpOnly");
  headers.set("vary", "x-auth-state");

  return {
    headers,
    status: 299,
  };
}

describe("app page execution helpers", () => {
  it("resolves a shell's special error as generateMetadata()'s only when the render threw it there alone", () => {
    const digest = "NEXT_HTTP_ERROR_FALLBACK;404";
    const decoded = Object.assign(new Error(digest), { digest });
    const fromMetadata = Object.assign(new Error(digest), {
      digest,
      [Symbol.for("vinext.appPage.metadataError")]: true,
    });
    const fromPage = tagAppPagePageError(Object.assign(new Error(digest), { digest }));

    expect(resolveAppPageShellSpecialError(decoded, [fromMetadata])).toEqual({
      kind: "http-access-fallback",
      statusCode: 404,
      fromMetadata: true,
    });
    expect(resolveAppPageShellSpecialError(decoded, [fromMetadata, fromPage])).toEqual({
      kind: "http-access-fallback",
      statusCode: 404,
    });
    expect(resolveAppPageShellSpecialError(decoded, [])).toEqual({
      kind: "http-access-fallback",
      statusCode: 404,
    });
  });

  it("resolves a shell's access fallback a route layout threw to the outermost such layout", () => {
    // A layout's boundaries wrap only its `children`, so its own notFound() is
    // caught above it, outside the boundary of any slot it renders.
    const digest = "NEXT_HTTP_ERROR_FALLBACK;404";
    const decoded = Object.assign(new Error(digest), { digest });
    const thrown = () => Object.assign(new Error(digest), { digest });

    expect(resolveAppPageShellSpecialError(decoded, [tagAppPageLayoutError(thrown(), 2)])).toEqual({
      kind: "http-access-fallback",
      statusCode: 404,
      layoutIndex: 2,
    });
    expect(
      resolveAppPageShellSpecialError(decoded, [
        tagAppPagePageError(thrown()),
        tagAppPageLayoutError(thrown(), 2),
        tagAppPageLayoutError(thrown(), 1),
      ]),
    ).toEqual({ kind: "http-access-fallback", statusCode: 404, layoutIndex: 1 });
    // The layout renders its slot, so the layout's signal wins over the slot's.
    expect(
      resolveAppPageShellSpecialError(decoded, [
        tagAppPageSlotError(thrown(), 1),
        tagAppPageLayoutError(thrown(), 1),
      ]),
    ).toEqual({ kind: "http-access-fallback", statusCode: 404, layoutIndex: 1 });
    // A slot an outer layout renders is caught above that outer layout.
    expect(
      resolveAppPageShellSpecialError(decoded, [
        tagAppPageSlotError(thrown(), 0),
        tagAppPageLayoutError(thrown(), 1),
      ]),
    ).toEqual({ kind: "http-access-fallback", statusCode: 404, slotLayoutIndex: 0 });
    // A copy a component the layout renders threw carries no tag.
    expect(
      resolveAppPageShellSpecialError(decoded, [tagAppPageLayoutError(thrown(), 2), thrown()]),
    ).toEqual({
      kind: "http-access-fallback",
      statusCode: 404,
      layoutIndex: 2,
      unattributed: true,
    });
    // Only an access fallback is attributed; a redirect is the same anywhere.
    const redirectDigest = "NEXT_REDIRECT;replace;/login;307;";
    const redirect = Object.assign(new Error(redirectDigest), { digest: redirectDigest });
    expect(
      resolveAppPageShellSpecialError(redirect, [tagAppPageLayoutError(redirect, 0)]),
    ).toMatchObject({ kind: "redirect" });
    expect(
      resolveAppPageShellSpecialError(redirect, [tagAppPageLayoutError(redirect, 0)]),
    ).not.toHaveProperty("layoutIndex");
  });

  it("resolves a special error a client component threw during SSR as the page's", () => {
    // generateMetadata() threw the same digest in the RSC render, but runs
    // only there, so an error SSR threw itself is never generateMetadata()'s.
    const digest = "NEXT_HTTP_ERROR_FALLBACK;404";
    const fromMetadata = Object.assign(new Error(digest), {
      digest,
      [Symbol.for("vinext.appPage.metadataError")]: true,
    });
    let thrownDuringSsr: unknown;
    try {
      notFound();
    } catch (error) {
      thrownDuringSsr = error;
    }

    expect(resolveAppPageShellSpecialError(thrownDuringSsr, [fromMetadata])).toEqual({
      kind: "http-access-fallback",
      statusCode: 404,
    });
  });

  it("resolves a shell's access fallback a parallel slot threw to the outermost slot's layout", () => {
    // Next.js attaches HTTP access fallback boundaries only to each segment's
    // `children`, so a slot's notFound() is caught above its layout, which is
    // never below the boundary that catches the page's.
    const digest = "NEXT_HTTP_ERROR_FALLBACK;404";
    const decoded = Object.assign(new Error(digest), { digest });
    const fromInnerSlot = tagAppPageSlotError(Object.assign(new Error(digest), { digest }), 2);
    const fromOuterSlot = tagAppPageSlotError(Object.assign(new Error(digest), { digest }), 1);
    const fromPage = tagAppPagePageError(Object.assign(new Error(digest), { digest }));

    expect(resolveAppPageShellSpecialError(decoded, [fromInnerSlot])).toEqual({
      kind: "http-access-fallback",
      statusCode: 404,
      slotLayoutIndex: 2,
    });
    expect(
      resolveAppPageShellSpecialError(decoded, [fromPage, fromInnerSlot, fromOuterSlot]),
    ).toEqual({
      kind: "http-access-fallback",
      statusCode: 404,
      slotLayoutIndex: 1,
    });
    expect(resolveAppPageShellSpecialError(decoded, [fromPage])).toEqual({
      kind: "http-access-fallback",
      statusCode: 404,
    });
    // Slots, renders and requests can share one thrown error, such as a
    // module-scoped rejected promise, so each throw tags its own copy.
    const shared = Object.freeze(Object.assign(new Error(digest), { digest }));
    const fromRootSlot = tagAppPageSlotError(shared, 0);
    expect(fromRootSlot).not.toBe(shared);
    expect(fromRootSlot).toBeInstanceOf(Error);
    expect(fromRootSlot).toMatchObject({ digest, message: digest, stack: shared.stack });
    // A copy nothing tagged may be from a component a layout renders.
    expect(resolveAppPageShellSpecialError(decoded, [shared])).toEqual({
      kind: "http-access-fallback",
      statusCode: 404,
      unattributed: true,
    });
    expect(
      resolveAppPageShellSpecialError(decoded, [tagAppPageSlotError(shared, 2)]),
    ).toMatchObject({ slotLayoutIndex: 2 });
    expect(
      resolveAppPageShellSpecialError(decoded, [
        tagAppPageSlotError(shared, 3),
        tagAppPageSlotError(shared, 1),
      ]),
    ).toMatchObject({ slotLayoutIndex: 1 });
    expect(
      resolveAppPageShellSpecialError(decoded, [tagAppPageSlotError(fromRootSlot, 2)]),
    ).toMatchObject({ slotLayoutIndex: 2 });

    const redirectDigest = "NEXT_REDIRECT;replace;%2Ftarget;307";
    const redirect = Object.assign(new Error(redirectDigest), { digest: redirectDigest });
    expect(
      resolveAppPageShellSpecialError(redirect, [tagAppPageSlotError(redirect, 1)]),
    ).not.toHaveProperty("slotLayoutIndex");
  });

  it("leaves a slot's notFound() its own not-found catches out of the slot's layout", () => {
    // Next.js catches that copy inside the slot, so the layout rendering the
    // slot stays, and the page's own notFound() goes to the page's boundary.
    const digest = "NEXT_HTTP_ERROR_FALLBACK;404";
    const decoded = Object.assign(new Error(digest), { digest });
    const thrown = () => Object.assign(new Error(digest), { digest });
    const fromPage = () => tagAppPagePageError(thrown());
    const caughtInSlot = tagAppPageSlotError(thrown(), 1, "slot:members:/team:0");

    expect(resolveAppPageShellSpecialError(decoded, [fromPage(), caughtInSlot])).toEqual({
      kind: "http-access-fallback",
      statusCode: 404,
    });
    expect(resolveAppPageShellSpecialError(decoded, [caughtInSlot])).toEqual({
      kind: "http-access-fallback",
      statusCode: 404,
    });
    // Another slot without its own not-found is still caught above its layout.
    expect(
      resolveAppPageShellSpecialError(decoded, [
        fromPage(),
        caughtInSlot,
        tagAppPageSlotError(thrown(), 2),
      ]),
    ).toMatchObject({ slotLayoutIndex: 2 });
    // A layout's or a template's notFound(), which no page or slot tag marks,
    // is caught above the layout rendering the slot, so the slot's copy keeps
    // that fallback.
    expect(resolveAppPageShellSpecialError(decoded, [thrown(), caughtInSlot])).toMatchObject({
      slotLayoutIndex: 1,
    });
    // Slots have only not-found boundaries, so a slot's forbidden() is still
    // caught above its layout.
    const forbiddenDigest = "NEXT_HTTP_ERROR_FALLBACK;403";
    const forbidden = Object.assign(new Error(forbiddenDigest), { digest: forbiddenDigest });
    expect(
      resolveAppPageShellSpecialError(forbidden, [
        tagAppPageSlotError(forbidden, 1, "slot:members:/team:0"),
      ]),
    ).toMatchObject({ slotLayoutIndex: 1 });
  });

  it("resolves the slot not-found boundaries that catch a shell's notFound()", () => {
    // On the client, a slot's own not-found boundary catches its notFound()
    // while the rest of the route renders, so the document renders those
    // boundaries caught when every copy the RSC render threw has one.
    const digest = "NEXT_HTTP_ERROR_FALLBACK;404";
    const decoded = Object.assign(new Error(digest), { digest });
    const thrown = () => Object.assign(new Error(digest), { digest });
    const teamSlot = tagAppPageSlotError(thrown(), 1, "slot:team:/:0");
    const modalSlot = tagAppPageSlotError(thrown(), 0, "slot:modal:/:1");

    expect(resolveAppPageCaughtNotFoundBoundaries(decoded, [teamSlot])).toEqual(["slot:team:/:0"]);
    expect(
      resolveAppPageCaughtNotFoundBoundaries(decoded, [
        teamSlot,
        modalSlot,
        tagAppPageSlotError(thrown(), 1, "slot:team:/:0"),
      ]),
    ).toEqual(["slot:team:/:0", "slot:modal:/:1"]);
    // A copy from a slot without its own not-found leaves the fallback above
    // the layout.
    expect(
      resolveAppPageCaughtNotFoundBoundaries(decoded, [teamSlot, tagAppPageSlotError(thrown(), 1)]),
    ).toBeNull();
    expect(resolveAppPageCaughtNotFoundBoundaries(decoded, [])).toBeNull();
    // A tagged copy of a tagged error keeps only its own boundary.
    expect(
      resolveAppPageCaughtNotFoundBoundaries(decoded, [tagAppPageSlotError(teamSlot, 1)]),
    ).toBeNull();
    // Slots have only not-found boundaries, and a client component's signal
    // never reached the RSC render.
    const forbiddenDigest = "NEXT_HTTP_ERROR_FALLBACK;403";
    const forbidden = Object.assign(new Error(forbiddenDigest), { digest: forbiddenDigest });
    expect(
      resolveAppPageCaughtNotFoundBoundaries(forbidden, [
        tagAppPageSlotError(forbidden, 1, "slot:team:/:0"),
      ]),
    ).toBeNull();
    let clientNotFound: unknown;
    try {
      notFound();
    } catch (error) {
      clientNotFound = error;
    }
    expect(resolveAppPageCaughtNotFoundBoundaries(clientNotFound, [teamSlot])).toBeNull();
  });

  it("renders the page's not-found boundary caught beside the slot boundaries", () => {
    // Next.js catches the page's notFound() with the page's boundary while a
    // slot's own not-found catches the slot's, and the client shows both.
    const digest = "NEXT_HTTP_ERROR_FALLBACK;404";
    const decoded = Object.assign(new Error(digest), { digest });
    const thrown = () => Object.assign(new Error(digest), { digest });
    const fromPage = () => tagAppPagePageError(thrown());
    const teamSlot = tagAppPageSlotError(thrown(), 1, "slot:team:/:0");

    expect(resolveAppPageCaughtNotFoundBoundaries(decoded, [fromPage(), teamSlot])).toEqual([
      APP_PAGE_NOT_FOUND_BOUNDARY_ID,
      "slot:team:/:0",
    ]);
    // Without a slot's, the page's own fallback renders, as before.
    expect(resolveAppPageCaughtNotFoundBoundaries(decoded, [fromPage()])).toBeNull();
    // A slot that no boundary of its own catches still leaves the fallback.
    expect(
      resolveAppPageCaughtNotFoundBoundaries(decoded, [
        fromPage(),
        teamSlot,
        tagAppPageSlotError(thrown(), 1),
      ]),
    ).toBeNull();
    // A copy no tag marks may come from a component the page renders, which
    // the page's boundary catches. A layout's or a template's renders outside
    // the caught boundaries, so the document's render throws it again and
    // takes the fallback, which keeps it above the slot's layout.
    expect(resolveAppPageCaughtNotFoundBoundaries(decoded, [thrown(), teamSlot])).toEqual([
      APP_PAGE_NOT_FOUND_BOUNDARY_ID,
      "slot:team:/:0",
    ]);
    expect(resolveAppPageShellSpecialError(decoded, [thrown(), teamSlot])).toMatchObject({
      slotLayoutIndex: 1,
    });
    expect(resolveAppPageShellSpecialError(decoded, [fromPage(), teamSlot])).toEqual({
      kind: "http-access-fallback",
      statusCode: 404,
    });
    // A page tag is a copy, as a slot's is.
    const shared = Object.freeze(thrown());
    expect(tagAppPagePageError(shared)).not.toBe(shared);
    expect(tagAppPagePageError(shared)).toMatchObject({ digest, message: digest });
  });

  it("parses redirect and access-fallback digests", () => {
    expect(
      resolveAppPageSpecialError({
        digest: "NEXT_REDIRECT;replace;%2Fredirected;308",
      }),
    ).toEqual({
      kind: "redirect",
      location: "/redirected",
      statusCode: 308,
      type: "replace",
    });

    expect(
      resolveAppPageSpecialError({
        digest: "NEXT_HTTP_ERROR_FALLBACK;403",
      }),
    ).toEqual({
      kind: "http-access-fallback",
      statusCode: 403,
    });

    expect(resolveAppPageSpecialError({ digest: "not-special" })).toBeNull();
  });

  it("builds redirect and fallback responses while preserving fallback context behavior", async () => {
    const clearRequestContext = vi.fn();

    const redirectResponse = await buildAppPageSpecialErrorResponse({
      clearRequestContext,
      isRscRequest: false,
      middlewareContext: createMiddlewareContext(),
      request: new Request("https://example.com/start"),
      specialError: {
        kind: "redirect",
        location: "/redirected",
        statusCode: 307,
        type: "replace",
      },
    });

    expect(redirectResponse.status).toBe(307);
    expect(redirectResponse.headers.get("location")).toBe("/redirected");
    expect(redirectResponse.headers.get("x-middleware-security")).toBe("present");
    expect(redirectResponse.headers.get("vary")).toBe("x-auth-state");
    expect(redirectResponse.headers.getSetCookie()).toContain("session=rotated; Path=/; HttpOnly");
    expect(clearRequestContext).toHaveBeenCalledTimes(1);

    clearRequestContext.mockClear();

    const fallbackResponse = await buildAppPageSpecialErrorResponse({
      clearRequestContext,
      isRscRequest: false,
      middlewareContext: createMiddlewareContext(),
      renderFallbackPage(statusCode) {
        return Promise.resolve(
          new Response(`fallback:${statusCode}`, {
            headers: { Vary: "RSC, Accept" },
            status: statusCode,
          }),
        );
      },
      request: new Request("https://example.com/start"),
      specialError: {
        kind: "http-access-fallback",
        statusCode: 404,
      },
    });

    expect(fallbackResponse.status).toBe(404);
    expect(fallbackResponse.headers.get("x-middleware-security")).toBe("present");
    expect(fallbackResponse.headers.get("vary")).toBe("RSC, Accept, x-auth-state");
    expect(fallbackResponse.headers.getSetCookie()).toContain("session=rotated; Path=/; HttpOnly");
    expect(
      fallbackResponse.headers
        .getSetCookie()
        .filter((cookie) => cookie === "session=rotated; Path=/; HttpOnly"),
    ).toHaveLength(1);
    await expect(fallbackResponse.text()).resolves.toBe("fallback:404");
    expect(clearRequestContext).not.toHaveBeenCalled();
  });

  it("prefixes redirect Location with basePath for app-internal paths", async () => {
    // Mirrors Next.js's `addPathPrefix(getURLFromRedirectError(err), basePath)`.
    // `redirect("/about")` from a page mounted under basePath "/blog" should
    // produce `Location: https://example.com/blog/about`, not the raw "/about".
    const clearRequestContext = vi.fn();

    const internalRedirect = await buildAppPageSpecialErrorResponse({
      basePath: "/blog",
      clearRequestContext,
      isRscRequest: false,
      request: new Request("https://example.com/blog/protected"),
      specialError: {
        kind: "redirect",
        location: "/about",
        statusCode: 307,
        type: "replace",
      },
    });

    expect(internalRedirect.headers.get("location")).toBe("/blog/about");

    // External redirects (different origin) must NOT be prefixed — they're
    // outside the app's basePath scope.
    const externalRedirect = await buildAppPageSpecialErrorResponse({
      basePath: "/blog",
      clearRequestContext,
      isRscRequest: false,
      request: new Request("https://example.com/blog/protected"),
      specialError: {
        kind: "redirect",
        location: "https://other.example/foo",
        statusCode: 307,
        type: "replace",
      },
    });

    expect(externalRedirect.headers.get("location")).toBe("https://other.example/foo");

    const sameOriginAbsoluteRedirect = await buildAppPageSpecialErrorResponse({
      basePath: "/blog",
      clearRequestContext,
      isRscRequest: false,
      request: new Request("https://example.com/blog/protected"),
      specialError: {
        kind: "redirect",
        location: "https://example.com/outside",
        statusCode: 307,
        type: "replace",
      },
    });

    expect(sameOriginAbsoluteRedirect.headers.get("location")).toBe("https://example.com/outside");

    const relativeRedirect = await buildAppPageSpecialErrorResponse({
      basePath: "/blog",
      clearRequestContext,
      isRscRequest: false,
      request: new Request("https://example.com/blog/protected"),
      specialError: {
        kind: "redirect",
        location: "next",
        statusCode: 307,
        type: "replace",
      },
    });

    expect(relativeRedirect.headers.get("location")).toBe("next");

    const protocolRelativeRedirect = await buildAppPageSpecialErrorResponse({
      basePath: "/blog",
      clearRequestContext,
      isRscRequest: false,
      request: new Request("https://example.com/blog/protected"),
      specialError: {
        kind: "redirect",
        location: "//other.example/foo",
        statusCode: 307,
        type: "replace",
      },
    });

    expect(protocolRelativeRedirect.headers.get("location")).toBe("/blog//other.example/foo");

    // Next.js's addPathPrefix unconditionally prepends basePath to every raw
    // slash-prefixed target, even if the caller already included it.
    const alreadyPrefixed = await buildAppPageSpecialErrorResponse({
      basePath: "/blog",
      clearRequestContext,
      isRscRequest: false,
      request: new Request("https://example.com/blog/protected"),
      specialError: {
        kind: "redirect",
        location: "/blog/about",
        statusCode: 307,
        type: "replace",
      },
    });

    expect(alreadyPrefixed.headers.get("location")).toBe("/blog/blog/about");

    const alreadyPrefixedRootWithQuery = await buildAppPageSpecialErrorResponse({
      basePath: "/blog",
      clearRequestContext,
      isRscRequest: false,
      request: new Request("https://example.com/blog/protected"),
      specialError: {
        kind: "redirect",
        location: "/blog?from=checkout",
        statusCode: 307,
        type: "replace",
      },
    });

    expect(alreadyPrefixedRootWithQuery.headers.get("location")).toBe("/blog/blog?from=checkout");

    const alreadyPrefixedRootWithHash = await buildAppPageSpecialErrorResponse({
      basePath: "/blog",
      clearRequestContext,
      isRscRequest: false,
      request: new Request("https://example.com/blog/protected"),
      specialError: {
        kind: "redirect",
        location: "/blog#top",
        statusCode: 307,
        type: "replace",
      },
    });

    expect(alreadyPrefixedRootWithHash.headers.get("location")).toBe("/blog/blog#top");

    // No basePath configured → behavior unchanged (resolves against the
    // request URL as before).
    const unconfigured = await buildAppPageSpecialErrorResponse({
      clearRequestContext,
      isRscRequest: false,
      request: new Request("https://example.com/protected"),
      specialError: {
        kind: "redirect",
        location: "/about",
        statusCode: 307,
        type: "replace",
      },
    });

    expect(unconfigured.headers.get("location")).toBe("/about");

    // Raw prefixing preserves the original root slash.
    const rootRedirect = await buildAppPageSpecialErrorResponse({
      basePath: "/blog",
      clearRequestContext,
      isRscRequest: false,
      request: new Request("https://example.com/blog/protected"),
      specialError: {
        kind: "redirect",
        location: "/",
        statusCode: 307,
        type: "replace",
      },
    });

    expect(rootRedirect.headers.get("location")).toBe("/blog/");
  });

  it("buffers a binary stream once and replays its original chunks", async () => {
    let pullCount = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        pullCount += 1;
        if (pullCount === 1) controller.enqueue(new TextEncoder().encode("first"));
        else if (pullCount === 2) controller.enqueue(new TextEncoder().encode("second"));
        else controller.close();
      },
    });

    const replay = await bufferAppPageBinaryStream(source);

    expect(pullCount).toBe(3);
    await expect(readStreamAsText(replay)).resolves.toBe("firstsecond");
    expect(pullCount).toBe(3);
  });

  it("appends pending cookies (cookies().set during render) to redirect responses", async () => {
    // Mirrors Next.js's `appendMutableCookies(headers, requestStore.mutableCookies)`
    // in app-render.tsx. An auth flow that does
    //   cookies().set("session", "...");
    //   redirect("/dashboard");
    // must keep the Set-Cookie on the 307 — otherwise the redirected
    // request lands without the just-issued session and the user bounces
    // back to login.
    const clearRequestContext = vi.fn();
    const getAndClearPendingCookies = vi.fn(() => [
      "session=fresh; Path=/; HttpOnly",
      "csrf=abc; Path=/",
    ]);

    const redirectWithCookies = await buildAppPageSpecialErrorResponse({
      clearRequestContext,
      getAndClearPendingCookies,
      isRscRequest: false,
      request: new Request("https://example.com/login"),
      specialError: {
        kind: "redirect",
        location: "/dashboard",
        statusCode: 307,
        type: "replace",
      },
    });

    expect(redirectWithCookies.status).toBe(307);
    expect(redirectWithCookies.headers.get("location")).toBe("/dashboard");
    const setCookies = redirectWithCookies.headers.getSetCookie();
    expect(setCookies).toContain("session=fresh; Path=/; HttpOnly");
    expect(setCookies).toContain("csrf=abc; Path=/");
    expect(getAndClearPendingCookies).toHaveBeenCalledTimes(1);

    // No accumulated cookies → no Set-Cookie header (and the accumulator
    // is still consulted exactly once).
    getAndClearPendingCookies.mockReturnValue([]);
    const redirectWithoutCookies = await buildAppPageSpecialErrorResponse({
      clearRequestContext,
      getAndClearPendingCookies,
      isRscRequest: false,
      request: new Request("https://example.com/login"),
      specialError: {
        kind: "redirect",
        location: "/dashboard",
        statusCode: 307,
        type: "replace",
      },
    });

    expect(redirectWithoutCookies.headers.getSetCookie()).toEqual([]);

    // Pending cookies must NOT bleed onto http-access-fallback responses —
    // those cookies belong to the rendered boundary, not the bare 401/403/404.
    // Matches Next.js, which only calls appendMutableCookies in the redirect
    // branch.
    getAndClearPendingCookies.mockReturnValue(["should-not-appear=1; Path=/"]);
    const fallbackResponse = await buildAppPageSpecialErrorResponse({
      clearRequestContext,
      getAndClearPendingCookies,
      isRscRequest: false,
      request: new Request("https://example.com/protected"),
      specialError: {
        kind: "http-access-fallback",
        statusCode: 401,
      },
    });

    expect(fallbackResponse.headers.getSetCookie()).toEqual([]);
  });

  it("falls back to a plain status response when no fallback page is available", async () => {
    const clearRequestContext = vi.fn();

    const response = await buildAppPageSpecialErrorResponse({
      clearRequestContext,
      isRscRequest: false,
      middlewareContext: createMiddlewareContext(),
      renderFallbackPage() {
        return Promise.resolve(null);
      },
      request: new Request("https://example.com/start"),
      specialError: {
        kind: "http-access-fallback",
        statusCode: 401,
      },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("x-middleware-security")).toBe("present");
    expect(response.headers.get("vary")).toBe("x-auth-state");
    expect(response.headers.getSetCookie()).toContain("session=rotated; Path=/; HttpOnly");
    await expect(response.text()).resolves.toBe("Unauthorized");
    expect(clearRequestContext).toHaveBeenCalledTimes(1);
  });

  it("encodes redirect digest in flight payload + 200 when buildRscRedirectFlightStream is provided (RSC request)", async () => {
    // Mirrors Next.js's `generateDynamicFlightRenderResult` path: when a
    // server component throws redirect() during RSC rendering, the redirect
    // digest is serialized into the flight stream and the response stays
    // 200. The status line never carries the redirect.
    //
    // See: https://github.com/cloudflare/vinext/issues/1347
    const buildRscRedirectFlightStream = vi.fn(
      (options: { digest: string }) =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`E:${options.digest}`));
            controller.close();
          },
        }),
    );

    const response = await buildAppPageSpecialErrorResponse({
      buildRscRedirectFlightStream,
      clearRequestContext: vi.fn(),
      isRscRequest: true,
      request: new Request("https://example.com/start.rsc"),
      specialError: {
        kind: "redirect",
        location: "/redirected",
        statusCode: 307,
        type: "replace",
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^text\/x-component/);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("x-vinext-rsc-redirect")).toBe("/redirected");
    expect(response.headers.get("x-vinext-rsc-redirect-type")).toBe("replace");
    expect(buildRscRedirectFlightStream).toHaveBeenCalledTimes(1);
    expect(buildRscRedirectFlightStream).toHaveBeenCalledWith({
      digest: "NEXT_REDIRECT;replace;/redirected;307;",
    });
    await expect(response.text()).resolves.toBe("E:NEXT_REDIRECT;replace;/redirected;307;");
  });

  // Next.js's digest keeps the target redirect() received, so one shared
  // cache entry sends every host to the same place.
  it("keeps a same-origin absolute redirect target in the RSC flight on every host", async () => {
    const payloads = [];
    for (const origin of ["https://www.example.com", "https://example.com"]) {
      const response = await buildAppPageSpecialErrorResponse({
        buildRscRedirectFlightStream: ({ digest }) => createStream([digest]),
        clearRequestContext: vi.fn(),
        isRscRequest: true,
        request: new Request(`${origin}/start.rsc`),
        specialError: {
          kind: "redirect",
          location: "https://www.example.com/target",
          statusCode: 307,
          type: "replace",
        },
      });
      payloads.push({
        body: await response.text(),
        header: response.headers.get("x-vinext-rsc-redirect"),
      });
    }

    expect(payloads[0]).toEqual({
      body: "NEXT_REDIRECT;replace;https://www.example.com/target;307;",
      header: "https://www.example.com/target",
    });
    expect(payloads[1]).toEqual(payloads[0]);
  });

  it.each([
    ["./subpage", "/docs/subpage"],
    ["?tab=1", "/docs/page?tab=1"],
    ["#section", "/docs/page#section"],
    // A same-origin path whose resolved pathname begins with "//" must not be
    // sent as a protocol-relative URL naming another host.
    ["/.//other.test/out", "/.//other.test/out"],
    ["/x/..//other.test/out?a=1#f", "/.//other.test/out?a=1#f"],
  ])(
    "resolves a relative RSC redirect target %s against the request path",
    async (location, url) => {
      const response = await buildAppPageSpecialErrorResponse({
        buildRscRedirectFlightStream: ({ digest }) => createStream([digest]),
        clearRequestContext: vi.fn(),
        isRscRequest: true,
        request: new Request("https://example.com/docs/page"),
        specialError: { kind: "redirect", location, statusCode: 307, type: "replace" },
      });

      expect(response.headers.get("x-vinext-rsc-redirect")).toBe(url);
      await expect(response.text()).resolves.toBe(`NEXT_REDIRECT;replace;${url};307;`);
    },
  );

  // One shared entry answers HTTP and HTTPS hosts, so a target that inherits
  // the scheme keeps its reference form and each client resolves it.
  it.each(["//other.test/out", "//other.test:443/out", "https:foo", "http:foo"])(
    "keeps the RSC redirect target %s in the same form on every scheme",
    async (location) => {
      const payloads = [];
      for (const origin of ["http://tenant-a.example", "https://tenant-b.example"]) {
        const response = await buildAppPageSpecialErrorResponse({
          buildRscRedirectFlightStream: ({ digest }) => createStream([digest]),
          clearRequestContext: vi.fn(),
          isRscRequest: true,
          request: new Request(`${origin}/start.rsc`),
          specialError: { kind: "redirect", location, statusCode: 307, type: "replace" },
        });
        payloads.push({
          body: await response.text(),
          header: response.headers.get("x-vinext-rsc-redirect"),
        });
      }

      expect(payloads[0]).toEqual({
        body: `NEXT_REDIRECT;replace;${location};307;`,
        header: location,
      });
      expect(payloads[1]).toEqual(payloads[0]);
    },
  );

  it.each([
    [" https://other.test/out", "https://other.test/out"],
    ["https://other.test/😀", "https://other.test/%F0%9F%98%80"],
    ["https://other.tést/a b", "https://other.t%C3%A9st/a%20b"],
    ["//other.test/😀", "//other.test/%F0%9F%98%80"],
    ["https://a.redirect-base.vinext.invalid/out", "https://a.redirect-base.vinext.invalid/out"],
    ["//a.redirect-base.vinext.invalid/out", "//a.redirect-base.vinext.invalid/out"],
    ["http://b.redirect-base.vinext.invalid/out", "http://b.redirect-base.vinext.invalid/out"],
  ])(
    "keeps the absolute RSC redirect target %s in the digest and parses it for the header",
    async (location, header) => {
      const response = await buildAppPageSpecialErrorResponse({
        buildRscRedirectFlightStream: ({ digest }) => createStream([digest]),
        clearRequestContext: vi.fn(),
        isRscRequest: true,
        request: new Request("https://example.com/docs/page"),
        specialError: { kind: "redirect", location, statusCode: 307, type: "replace" },
      });

      expect(response.headers.get("x-vinext-rsc-redirect")).toBe(header);
      await expect(response.text()).resolves.toBe(`NEXT_REDIRECT;replace;${location};307;`);
    },
  );

  it("preserves explicit push semantics in RSC redirect flights", async () => {
    const buildRscRedirectFlightStream = vi.fn(
      ({ digest }: { digest: string }) =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(digest));
            controller.close();
          },
        }),
    );

    const response = await buildAppPageSpecialErrorResponse({
      buildRscRedirectFlightStream,
      clearRequestContext: vi.fn(),
      isRscRequest: true,
      request: new Request("https://example.com/start.rsc"),
      specialError: {
        kind: "redirect",
        location: "/redirected",
        statusCode: 307,
        type: "push",
      },
    });

    expect(response.headers.get("x-vinext-rsc-redirect-type")).toBe("push");
    expect(buildRscRedirectFlightStream).toHaveBeenCalledWith({
      digest: "NEXT_REDIRECT;push;/redirected;307;",
    });
  });

  it("keeps framework redirect side-channel headers authoritative over middleware", async () => {
    const middlewareHeaders = new Headers({
      [VINEXT_RSC_BUILD_ID_HEADER]: "middleware-build",
      [VINEXT_RSC_COMPATIBILITY_ID_HEADER]: "middleware-compat",
      "X-Vinext-Rsc-Redirect": "/middleware-target",
      "X-Vinext-Rsc-Redirect-Type": "push",
    });
    const response = await withEnvVar("__VINEXT_RSC_COMPATIBILITY_ID", "framework-compat", () =>
      withEnvVar("__VINEXT_RSC_BUILD_IDENTITY", "framework-build", () =>
        buildAppPageSpecialErrorResponse({
          buildRscRedirectFlightStream: ({ digest }) => createStream([digest]),
          clearRequestContext: vi.fn(),
          isRscRequest: true,
          middlewareContext: { headers: middlewareHeaders },
          request: new Request("https://example.com/start.rsc"),
          specialError: {
            kind: "redirect",
            location: "/actual-target",
            statusCode: 307,
            type: "replace",
          },
        }),
      ),
    );

    expect(response.headers.get(VINEXT_RSC_BUILD_ID_HEADER)).toBe("framework-build");
    expect(response.headers.get(VINEXT_RSC_COMPATIBILITY_ID_HEADER)).toBe("framework-compat");
    expect(response.headers.get("x-vinext-rsc-redirect")).toBe("/actual-target");
    expect(response.headers.get("x-vinext-rsc-redirect-type")).toBe("replace");
  });

  it("preserves semicolons through encoded redirect parsing and raw Flight re-emission", async () => {
    const specialError = resolveAppPageSpecialError({
      digest: "NEXT_REDIRECT;;%2Fdocs%3Bpart;307",
    });
    expect(specialError).toEqual({
      kind: "redirect",
      location: "/docs;part",
      statusCode: 307,
      type: "replace",
    });

    const buildRscRedirectFlightStream = vi.fn(
      (options: { digest: string }) =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(options.digest));
            controller.close();
          },
        }),
    );
    const response = await buildAppPageSpecialErrorResponse({
      buildRscRedirectFlightStream,
      clearRequestContext: vi.fn(),
      isRscRequest: true,
      request: new Request("https://example.com/start.rsc"),
      specialError: specialError!,
    });
    const emittedDigest = await response.text();

    expect(emittedDigest).toBe("NEXT_REDIRECT;replace;/docs;part;307;");
    expect(parseNextRedirectDigest(emittedDigest)).toEqual({
      status: 307,
      type: "replace",
      url: "/docs;part",
    });
  });

  it("keeps metadata-originated RSC redirects on the Flight digest path", async () => {
    // Ported from Next.js:
    // test/e2e/app-dir/metadata-streaming/metadata-streaming.test.ts
    //   "should trigger redirection when call redirect"
    //
    // Document requests and RSC navigation requests intentionally diverge:
    // the document path streams a refresh meta tag, while the client router
    // still consumes the redirect digest from the Flight stream.
    const buildRscRedirectFlightStream = vi.fn(
      (options: { digest: string }) =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`E:${options.digest}`));
            controller.close();
          },
        }),
    );

    const response = await buildAppPageSpecialErrorResponse({
      buildRscRedirectFlightStream,
      clearRequestContext: vi.fn(),
      isRscRequest: true,
      request: new Request("https://example.com/start.rsc"),
      specialError: {
        kind: "redirect",
        location: "/redirected",
        statusCode: 307,
        type: "replace",
        fromMetadata: true,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^text\/x-component/);
    expect(response.headers.get("location")).toBeNull();
    expect(buildRscRedirectFlightStream).toHaveBeenCalledTimes(1);
    expect(buildRscRedirectFlightStream).toHaveBeenCalledWith({
      digest: "NEXT_REDIRECT;replace;/redirected;307;",
    });
    await expect(response.text()).resolves.toBe("E:NEXT_REDIRECT;replace;/redirected;307;");
  });

  it("renders a metadata-originated document redirect as an HTML refresh when metadata streams", async () => {
    // Ported from Next.js:
    // test/e2e/app-dir/metadata-streaming/metadata-streaming.test.ts
    //   "should trigger redirection when call redirect"
    //
    // Next.js captures redirect() thrown by generateMetadata() as a streamed
    // server error and injects the canonical refresh meta tag through
    // make-get-server-inserted-html.tsx. The document status stays 200, but it
    // must remain an HTML document so a browser direct visit can follow it.
    const buildRscRedirectFlightStream = vi.fn(
      () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("flight-payload"));
            controller.close();
          },
        }),
    );

    const response = await buildAppPageSpecialErrorResponse({
      buildRscRedirectFlightStream,
      clearRequestContext: vi.fn(),
      isRscRequest: false,
      request: new Request("https://example.com/start"),
      specialError: {
        kind: "redirect",
        location: "/redirected",
        statusCode: 307,
        type: "replace",
        fromMetadata: true,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(buildRscRedirectFlightStream).not.toHaveBeenCalled();
    await expect(response.text()).resolves.toContain(
      '<meta id="__next-page-redirect" http-equiv="refresh" content="1;url=/redirected"/>',
    );
  });

  it("uses an HTTP redirect for metadata-originated redirects when metadata streaming is disabled", async () => {
    // Ported from Next.js:
    // test/e2e/app-dir/metadata-streaming/metadata-streaming.test.ts
    //   "should render blocking 307 response status when html limited bots access redirect"
    const buildRscRedirectFlightStream = vi.fn(
      () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("flight-payload"));
            controller.close();
          },
        }),
    );

    const response = await buildAppPageSpecialErrorResponse({
      buildRscRedirectFlightStream,
      clearRequestContext: vi.fn(),
      isRscRequest: false,
      request: new Request("https://example.com/start"),
      serveStreamingMetadata: false,
      specialError: {
        kind: "redirect",
        location: "/redirected",
        statusCode: 307,
        type: "replace",
        fromMetadata: true,
      },
    });

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("/redirected");
    expect(buildRscRedirectFlightStream).not.toHaveBeenCalled();
  });

  it("preserves the 307/308 status code in the encoded digest (permanentRedirect)", async () => {
    const captured: { digest: string }[] = [];
    const buildRscRedirectFlightStream = (opts: { digest: string }) => {
      captured.push(opts);
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      });
    };

    await buildAppPageSpecialErrorResponse({
      buildRscRedirectFlightStream,
      clearRequestContext: vi.fn(),
      isRscRequest: true,
      request: new Request("https://example.com/start.rsc"),
      specialError: {
        kind: "redirect",
        location: "/permanent-target",
        statusCode: 308,
        type: "replace",
      },
    });

    expect(captured).toEqual([{ digest: "NEXT_REDIRECT;replace;/permanent-target;308;" }]);
  });

  it("falls back to 307 when buildRscRedirectFlightStream is absent (backward compat)", async () => {
    // Callers that don't yet plumb the flight-stream builder keep the legacy
    // behavior: HTTP 307 with a Location header. Keeps non-app-router callers
    // (and any test helpers) working without changes.
    const response = await buildAppPageSpecialErrorResponse({
      clearRequestContext: vi.fn(),
      isRscRequest: true,
      request: new Request("https://example.com/start.rsc"),
      specialError: {
        kind: "redirect",
        location: "/redirected",
        statusCode: 307,
        type: "replace",
      },
    });

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toMatch(/redirected\?_rsc/);
  });

  it("canonicalizes same-origin RSC redirect locations to Next-style RSC URLs", async () => {
    const response = await buildAppPageSpecialErrorResponse({
      clearRequestContext: vi.fn(),
      isRscRequest: true,
      request: new Request("https://example.com/start.rsc", {
        headers: {
          Accept: "text/x-component",
          RSC: "1",
          "Next-Router-State-Tree": "tree",
        },
      }),
      specialError: {
        kind: "redirect",
        location: "/redirected?tab=1",
        statusCode: 307,
        type: "replace",
      },
    });

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toMatch(
      /^https:\/\/example\.com\/redirected\?tab=1&_rsc=/,
    );
  });

  it("returns HTTP 200 when notFound() is thrown from generateMetadata (fromMetadata)", async () => {
    // Ported from Next.js:
    // test/e2e/app-dir/metadata-navigation/metadata-navigation.test.ts
    //   "should support notFound in generateMetadata"
    //
    // When notFound() / forbidden() / unauthorized() is thrown from
    // generateMetadata(), Next.js treats the error as a suspended metadata
    // result — the React not-found boundary handles the UI client-side while
    // the HTTP response stays 200. The rendered fallback response (status 404
    // from renderAppPageHttpAccessFallback) must be overridden to 200.
    const fallbackBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("not-found-boundary-html"));
        controller.close();
      },
    });
    const fallbackResponse = new Response(fallbackBody, {
      status: 404,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });

    const response = await buildAppPageSpecialErrorResponse({
      clearRequestContext: vi.fn(),
      isRscRequest: false,
      renderFallbackPage: async () => fallbackResponse,
      request: new Request("https://example.com/async/not-found"),
      specialError: {
        kind: "http-access-fallback",
        statusCode: 404,
        fromMetadata: true,
      },
    });

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("not-found-boundary-html");
  });

  it("preserves fallback framework Link provenance through metadata status and middleware merges", async () => {
    const fallbackResponse = new Response("not-found-boundary-html", {
      status: 404,
      headers: { Link: "</framework.css>; rel=preload; as=style" },
    });
    markFrameworkLinkHeaders(fallbackResponse.headers, fallbackResponse.headers.get("link"));

    const response = await buildAppPageSpecialErrorResponse({
      clearRequestContext: vi.fn(),
      isRscRequest: false,
      middlewareContext: {
        headers: new Headers({ Link: "</middleware.css>; rel=preload; as=style" }),
      },
      renderFallbackPage: async () => fallbackResponse,
      request: new Request("https://example.com/async/not-found"),
      specialError: {
        kind: "http-access-fallback",
        statusCode: 404,
        fromMetadata: true,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("link")).toBe(
      "</middleware.css>; rel=preload; as=style, </framework.css>; rel=preload; as=style",
    );
    expect(hasFrameworkLinkHeaders(response.headers)).toBe(true);
    await expect(response.text()).resolves.toBe("not-found-boundary-html");
  });

  it("returns HTTP 200 for metadata notFound when no fallback page is available", async () => {
    // When there is no renderFallbackPage (e.g. no not-found.tsx exists), the
    // plain text fallback should also be 200 for fromMetadata errors.
    const response = await buildAppPageSpecialErrorResponse({
      clearRequestContext: vi.fn(),
      isRscRequest: false,
      request: new Request("https://example.com/async/not-found"),
      specialError: {
        kind: "http-access-fallback",
        statusCode: 404,
        fromMetadata: true,
      },
    });

    expect(response.status).toBe(200);
  });

  it("returns HTTP 404 when notFound() is thrown from generateMetadata with serveStreamingMetadata:false (html-limited bot, with fallback)", async () => {
    // Ported from Next.js:
    // test/e2e/app-dir/metadata-streaming/metadata-streaming.test.ts
    //   "should render blocking 404 response status when html limited bots access notFound"
    //
    // When serveStreamingMetadata === false (html-limited bots), metadata blocks
    // the render synchronously. Next.js sets the real HTTP error status in this
    // path (app-render.tsx ~2845). Mirror the redirect-from-metadata path, which
    // is already gated on serveStreamingMetadata !== false.
    const fallbackBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("not-found-boundary-html"));
        controller.close();
      },
    });
    const fallbackResponse = new Response(fallbackBody, {
      status: 404,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });

    const response = await buildAppPageSpecialErrorResponse({
      clearRequestContext: vi.fn(),
      isRscRequest: false,
      renderFallbackPage: async () => fallbackResponse,
      request: new Request("https://example.com/async/not-found"),
      serveStreamingMetadata: false,
      specialError: {
        kind: "http-access-fallback",
        statusCode: 404,
        fromMetadata: true,
      },
    });

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("not-found-boundary-html");
  });

  it("returns HTTP 404 when notFound() is thrown from generateMetadata with serveStreamingMetadata:false (html-limited bot, no fallback)", async () => {
    // Same bot scenario but with no renderFallbackPage (no not-found.tsx).
    // The plain text fallback must also use the real error status.
    const response = await buildAppPageSpecialErrorResponse({
      clearRequestContext: vi.fn(),
      isRscRequest: false,
      request: new Request("https://example.com/async/not-found"),
      serveStreamingMetadata: false,
      specialError: {
        kind: "http-access-fallback",
        statusCode: 404,
        fromMetadata: true,
      },
    });

    expect(response.status).toBe(404);
  });

  it("returns the original status for non-metadata http-access-fallback errors", async () => {
    // Page-level notFound() calls (fromMetadata absent/false) must still return
    // the original 404 status — only metadata-originated errors get the 200
    // override.
    const fallbackResponse = new Response("page-level-not-found", { status: 404 });

    const response = await buildAppPageSpecialErrorResponse({
      clearRequestContext: vi.fn(),
      isRscRequest: false,
      renderFallbackPage: async () => fallbackResponse,
      request: new Request("https://example.com/page"),
      specialError: {
        kind: "http-access-fallback",
        statusCode: 404,
      },
    });

    expect(response.status).toBe(404);
  });

  it("produces fused ssrStream + sideStream when capturing (#981)", async () => {
    const capture = teeAppPageRscStreamForCapture(createStream(["flight-", "chunk"]), true);

    // ssrStream is for createFromReadableStream (SSR)
    expect(capture.ssrStream).toBeInstanceOf(ReadableStream);
    // sideStream is for embed+capture
    expect(capture.sideStream).toBeInstanceOf(ReadableStream);

    // Both streams should contain identical data (teed from same source)
    const ssrText = await readStreamAsText(capture.ssrStream);
    const sideText = await readStreamAsText(capture.sideStream!);
    expect(ssrText).toBe("flight-chunk");
    expect(sideText).toBe("flight-chunk");
  });

  it("bypasses tee when not capturing (#981)", async () => {
    const stream = createStream(["no-capture"]);
    const capture = teeAppPageRscStreamForCapture(stream, false);

    // When not capturing, no tee — the original stream is returned as ssrStream
    expect(capture.ssrStream).toBe(stream);
    expect(capture.sideStream).toBeUndefined();
  });

  it("builds Link headers for preloaded app-page fonts", () => {
    expect(
      buildAppPageFontLinkHeader([
        { href: "/font-a.woff2", type: "font/woff2" },
        { href: "/font-b.woff2", type: "font/woff2" },
      ]),
    ).toBe(
      "</font-a.woff2>; rel=preload; as=font; type=font/woff2; crossorigin, </font-b.woff2>; rel=preload; as=font; type=font/woff2; crossorigin",
    );
  });

  it("emits the `x-edge-runtime: 1` marker on RSC redirect flight responses for edge-runtime routes", async () => {
    const response = await buildAppPageSpecialErrorResponse({
      buildRscRedirectFlightStream: ({ digest }) =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`E:${digest}`));
            controller.close();
          },
        }),
      clearRequestContext: vi.fn(),
      isEdgeRuntime: true,
      isRscRequest: true,
      request: new Request("https://example.com/start.rsc"),
      specialError: { kind: "redirect", location: "/redirected", statusCode: 307 },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-edge-runtime")).toBe("1");
  });

  it("omits the `x-edge-runtime` marker on RSC redirect flight responses for nodejs-runtime routes", async () => {
    const response = await buildAppPageSpecialErrorResponse({
      buildRscRedirectFlightStream: ({ digest }) =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`E:${digest}`));
            controller.close();
          },
        }),
      clearRequestContext: vi.fn(),
      isRscRequest: true,
      request: new Request("https://example.com/start.rsc"),
      specialError: { kind: "redirect", location: "/redirected", statusCode: 307 },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-edge-runtime")).toBeNull();
  });
});
