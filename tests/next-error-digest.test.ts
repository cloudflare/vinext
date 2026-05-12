import { describe, expect, it } from "vite-plus/test";
import { parseNextRedirectDigest } from "../packages/vinext/src/server/next-error-digest.js";

describe("next error digest parsing", () => {
  // Mirrors Next.js redirect type semantics from:
  // https://github.com/vercel/next.js/blob/canary/packages/next/src/client/components/redirect.ts
  it("preserves an omitted redirect type so callers can apply context-sensitive defaults", () => {
    expect(parseNextRedirectDigest("NEXT_REDIRECT;;%2Fdashboard;307")).toEqual({
      status: 307,
      type: null,
      url: "/dashboard",
    });
  });

  it("preserves explicit redirect types", () => {
    expect(parseNextRedirectDigest("NEXT_REDIRECT;replace;%2Flogin;308")).toEqual({
      status: 308,
      type: "replace",
      url: "/login",
    });

    expect(parseNextRedirectDigest("NEXT_REDIRECT;push;%2Fprofile;307")).toEqual({
      status: 307,
      type: "push",
      url: "/profile",
    });
  });

  it("preserves non-empty redirect type segments as raw digest data", () => {
    expect(parseNextRedirectDigest("NEXT_REDIRECT;custom;%2Fprofile;307")).toEqual({
      status: 307,
      type: "custom",
      url: "/profile",
    });
  });
});
