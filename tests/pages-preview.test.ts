import { describe, expect, it, vi } from "vite-plus/test";
import {
  appendPagesPreviewClearCookies,
  clearPagesPreviewData,
  getPagesPreviewState,
  setPagesDraftMode,
  setPagesPreviewData,
} from "../packages/vinext/src/server/pages-preview.js";
import { getRevalidateSecret } from "../packages/vinext/src/server/isr-cache.js";
import { isDraftModeRequest } from "../packages/vinext/src/shims/headers.js";

function createResponse() {
  const headers = new Map<string, string | string[]>();
  return {
    getHeader(name: string) {
      return headers.get(name.toLowerCase());
    },
    setHeader(name: string, value: string | string[]) {
      headers.set(name.toLowerCase(), value);
    },
  };
}

function cookieHeader(response: ReturnType<typeof createResponse>): string {
  const cookies = response.getHeader("set-cookie");
  if (!Array.isArray(cookies)) throw new Error("expected preview cookies");
  return cookies.map((cookie) => cookie.split(";", 1)[0]).join("; ");
}

describe("Pages preview tokens", () => {
  it("encrypts and authenticates preview data", () => {
    const response = createResponse();
    setPagesPreviewData(response, { secret: "draft" });
    const cookies = response.getHeader("set-cookie");
    if (!Array.isArray(cookies)) throw new Error("expected preview cookies");
    expect(cookies.join("\n")).not.toContain("draft");
    expect(cookieHeader(response)).not.toContain(getRevalidateSecret());
    expect(getPagesPreviewState(cookieHeader(response))).toEqual({
      data: { secret: "draft" },
      shouldClear: false,
    });
  });

  it("rejects tampered preview data and requests cookie clearing", () => {
    const response = createResponse();
    setPagesPreviewData(response, { secret: "draft" });
    const header = cookieHeader(response).replace(
      /(__next_preview_data=)([^;])([^;]*)/,
      (_match, prefix: string, first: string, rest: string) =>
        `${prefix}${first === "a" ? "b" : "a"}${rest}`,
    );
    expect(getPagesPreviewState(header)).toEqual({ data: false, shouldClear: true });
  });

  it("rejects expired preview data", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const response = createResponse();
      setPagesPreviewData(response, { secret: "draft" }, { maxAge: 1 });
      vi.advanceTimersByTime(1000);
      expect(getPagesPreviewState(cookieHeader(response))).toEqual({
        data: false,
        shouldClear: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears both preview cookies", () => {
    const response = createResponse();
    clearPagesPreviewData(response, { path: "/docs" });
    expect(response.getHeader("set-cookie")).toEqual([
      expect.stringMatching(/^__prerender_bypass=; Expires=.*; HttpOnly; Path=\/docs;/),
      expect.stringMatching(/^__next_preview_data=; Expires=.*; HttpOnly; Path=\/docs;/),
    ]);
  });

  it("appends root host-only clears alongside scoped preview expirations", () => {
    const headers = new Headers();
    headers.append(
      "Set-Cookie",
      "__prerender_bypass=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Path=/draft",
    );
    headers.append(
      "Set-Cookie",
      "__next_preview_data=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; Domain=example.test",
    );

    appendPagesPreviewClearCookies(headers);

    expect(headers.getSetCookie()).toEqual([
      "__prerender_bypass=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Path=/draft",
      "__next_preview_data=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; Domain=example.test",
      expect.stringMatching(/^__prerender_bypass=; Expires=.*; HttpOnly; Path=\/;/),
      expect.stringMatching(/^__next_preview_data=; Expires=.*; HttpOnly; Path=\/;/),
    ]);
  });

  it("does not duplicate equivalent root host-only preview expirations", () => {
    const headers = new Headers();

    appendPagesPreviewClearCookies(headers);
    appendPagesPreviewClearCookies(headers);

    expect(headers.getSetCookie()).toEqual([
      expect.stringMatching(/^__prerender_bypass=; Expires=/),
      expect.stringMatching(/^__next_preview_data=; Expires=/),
    ]);
  });

  it("shares the bypass ID with App Router draft mode", () => {
    const previousId = process.env.__VINEXT_PREVIEW_MODE_ID;
    const previousSigningKey = process.env.__VINEXT_PREVIEW_MODE_SIGNING_KEY;
    const previousEncryptionKey = process.env.__VINEXT_PREVIEW_MODE_ENCRYPTION_KEY;
    const previewModeId = "1".repeat(32);
    process.env.__VINEXT_PREVIEW_MODE_ID = previewModeId;
    process.env.__VINEXT_PREVIEW_MODE_SIGNING_KEY = "2".repeat(64);
    process.env.__VINEXT_PREVIEW_MODE_ENCRYPTION_KEY = "3".repeat(64);
    try {
      const response = createResponse();
      setPagesDraftMode(response, true);
      const cookie = cookieHeader(response);

      expect(cookie).toBe(`__prerender_bypass=${previewModeId}`);
      expect(
        isDraftModeRequest(
          new Request("https://example.test/app", { headers: { cookie } }),
          previewModeId,
        ),
      ).toBe(true);
      expect(getPagesPreviewState(cookie)).toEqual({ data: {}, shouldClear: false });
    } finally {
      if (previousId === undefined) delete process.env.__VINEXT_PREVIEW_MODE_ID;
      else process.env.__VINEXT_PREVIEW_MODE_ID = previousId;
      if (previousSigningKey === undefined) delete process.env.__VINEXT_PREVIEW_MODE_SIGNING_KEY;
      else process.env.__VINEXT_PREVIEW_MODE_SIGNING_KEY = previousSigningKey;
      if (previousEncryptionKey === undefined) {
        delete process.env.__VINEXT_PREVIEW_MODE_ENCRYPTION_KEY;
      } else {
        process.env.__VINEXT_PREVIEW_MODE_ENCRYPTION_KEY = previousEncryptionKey;
      }
    }
  });
});
