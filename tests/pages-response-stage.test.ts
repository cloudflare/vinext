import { describe, expect, it, vi } from "vite-plus/test";
import {
  getPagesResponseStageCacheDisposition,
  shouldDispatchPagesResponseStage,
} from "../packages/vinext/src/server/pages-response-stage.js";
import { PRERENDER_REVALIDATE_HEADER } from "../packages/vinext/src/utils/protocol-headers.js";

function shouldDispatch(
  init: RequestInit = {},
  options: {
    authorizeOnDemandRevalidate?: (headerValue: string | null) => boolean;
    stagedHeaders?: Headers;
  } = {},
): boolean {
  return shouldDispatchPagesResponseStage({
    ...options,
    request: new Request("https://example.com/page", init),
  });
}

describe("Pages response-stage dispatch", () => {
  it("maps ordinary and request-specific renders to shared and bypass dispatch", () => {
    expect(
      getPagesResponseStageCacheDisposition({
        request: new Request("https://example.com/page"),
      }),
    ).toBe("shared");
    expect(
      getPagesResponseStageCacheDisposition({
        request: new Request("https://example.com/page", {
          headers: { Cookie: "__prerender_bypass=preview" },
        }),
      }),
    ).toBe("bypass");
  });

  it.each(["GET", "HEAD"])("allows an ordinary %s request", (method) => {
    expect(shouldDispatch({ method })).toBe(true);
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"])("keeps %s in the request stage", (method) => {
    expect(shouldDispatch({ method })).toBe(false);
  });

  it.each(["__prerender_bypass", "__next_preview_data"])(
    "keeps requests carrying the %s preview cookie local",
    (name) => {
      expect(shouldDispatch({ headers: { Cookie: `ordinary=1; ${name}=value; last=1` } })).toBe(
        false,
      );
    },
  );

  it("does not treat similarly named or unrelated cookies as preview mode", () => {
    expect(
      shouldDispatch({
        headers: {
          Cookie: "session=abc; prefix__prerender_bypass=value; __next_preview_data_extra=value",
        },
      }),
    ).toBe(true);
  });

  it.each([
    "no-cache",
    "NO-STORE",
    "max-age=0, no-cache",
    "public, no-store, max-age=60",
    'no-cache="set-cookie"',
  ])("keeps Cache-Control %s local", (cacheControl) => {
    expect(shouldDispatch({ headers: { "Cache-Control": cacheControl } })).toBe(false);
  });

  it.each(["max-age=0", "public, max-age=0, must-revalidate", "no-cacheable=true"])(
    "does not broaden bypass semantics for Cache-Control %s",
    (cacheControl) => {
      expect(shouldDispatch({ headers: { "Cache-Control": cacheControl } })).toBe(true);
    },
  );

  it("keeps authenticated on-demand revalidation local", () => {
    const authorize = vi.fn((value: string | null) => value === "build-secret");
    expect(
      shouldDispatch(
        { headers: { [PRERENDER_REVALIDATE_HEADER]: "build-secret" } },
        { authorizeOnDemandRevalidate: authorize },
      ),
    ).toBe(false);
    expect(authorize).toHaveBeenCalledWith("build-secret");
  });

  it("keeps authenticated on-demand revalidation out of the shared transport", () => {
    expect(
      getPagesResponseStageCacheDisposition({
        authorizeOnDemandRevalidate: (value) => value === "build-secret",
        request: new Request("https://example.com/page", {
          headers: { [PRERENDER_REVALIDATE_HEADER]: "build-secret" },
          method: "HEAD",
        }),
      }),
    ).toBe("bypass");
  });

  it("does not let a forged on-demand revalidation header force a bypass", () => {
    const authorize = vi.fn(() => false);
    expect(
      shouldDispatch(
        { headers: { [PRERENDER_REVALIDATE_HEADER]: "forged-secret" } },
        { authorizeOnDemandRevalidate: authorize },
      ),
    ).toBe(true);
  });

  it("keeps request and staged-response CSP nonces local", () => {
    expect(
      shouldDispatch({ headers: { "Content-Security-Policy": "script-src 'nonce-request'" } }),
    ).toBe(false);
    expect(
      shouldDispatch(
        {},
        {
          stagedHeaders: new Headers({
            "Content-Security-Policy": "script-src 'self' 'nonce-middleware'",
          }),
        },
      ),
    ).toBe(false);
  });

  it.each([
    ["Cache-Control", "private, max-age=0"],
    ["CDN-Cache-Control", "public, max-age=60, no-store"],
    ["Cloudflare-CDN-Cache-Control", "NO-CACHE"],
  ])("keeps the inner artifact reusable under outer staged %s: %s", (name, value) => {
    expect(shouldDispatch({}, { stagedHeaders: new Headers({ [name]: value }) })).toBe(true);
  });

  it("keeps the inner artifact reusable under outer staged Vary", () => {
    expect(shouldDispatch({}, { stagedHeaders: new Headers({ Vary: "x-visitor-id" }) })).toBe(true);
  });

  it("keeps middleware cookie overlays local", () => {
    expect(
      shouldDispatch(
        {},
        { stagedHeaders: new Headers({ "x-middleware-set-cookie": "session=updated" }) },
      ),
    ).toBe(false);
  });

  it("keeps middleware request-header overrides out of the shared stage", () => {
    expect(
      shouldDispatchPagesResponseStage({
        request: new Request("https://example.com/page"),
        requestHeadersChanged: true,
      }),
    ).toBe(false);
  });

  it("keeps getStaticProps renders with request-aware Documents out of the shared stage", () => {
    // Next.js passes req/res to `_document.getInitialProps` whenever the page is
    // not an automatic static export, including getStaticProps/ISR renders.
    // https://github.com/vercel/next.js/blob/canary/packages/next/src/server/render.tsx
    expect(
      shouldDispatchPagesResponseStage({
        hasRequestAwareDocument: true,
        request: new Request("https://example.com/page"),
        routeDataKind: "static",
      }),
    ).toBe(false);
    expect(
      shouldDispatchPagesResponseStage({
        hasRequestAwareDocument: false,
        request: new Request("https://example.com/page"),
        routeDataKind: "static",
      }),
    ).toBe(true);
    expect(
      shouldDispatchPagesResponseStage({
        hasRequestAwareDocument: true,
        request: new Request("https://example.com/page"),
        routeDataKind: "none",
      }),
    ).toBe(true);
  });
});
