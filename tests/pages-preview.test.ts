import { describe, expect, it, vi } from "vite-plus/test";
import {
  clearPagesPreviewData,
  getPagesPreviewState,
  setPagesPreviewData,
} from "../packages/vinext/src/server/pages-preview.js";

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
});
