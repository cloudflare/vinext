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

  it("preserves semicolons inside redirect URLs", () => {
    expect(
      parseNextRedirectDigest(
        "NEXT_REDIRECT;replace;javascript:window.location.assign('/boom');;307;",
      ),
    ).toEqual({
      status: 307,
      type: "replace",
      url: "javascript:window.location.assign('/boom');",
    });
  });

  it("preserves percent escapes and literal percent signs in Next-style raw URLs", () => {
    expect(parseNextRedirectDigest("NEXT_REDIRECT;replace;/docs%2Fguide%3Bpart;307;")).toEqual({
      status: 307,
      type: "replace",
      url: "/docs%2Fguide%3Bpart",
    });

    expect(parseNextRedirectDigest("NEXT_REDIRECT;replace;/discount/100%;307;")).toEqual({
      status: 307,
      type: "replace",
      url: "/discount/100%",
    });
  });

  it("decodes vinext's encoded redirect URLs", () => {
    expect(parseNextRedirectDigest("NEXT_REDIRECT;replace;%2Fdocs%252Fguide%253Bpart;307")).toEqual(
      {
        status: 307,
        type: "replace",
        url: "/docs%2Fguide%3Bpart",
      },
    );
  });

  it("accepts empty redirect URLs", () => {
    expect(parseNextRedirectDigest("NEXT_REDIRECT;replace;;307;")).toEqual({
      status: 307,
      type: "replace",
      url: "",
    });

    expect(parseNextRedirectDigest("NEXT_REDIRECT;replace;;307")).toEqual({
      status: 307,
      type: "replace",
      url: "",
    });
  });

  it("preserves semicolons inside redirect URLs when status is omitted", () => {
    expect(parseNextRedirectDigest("NEXT_REDIRECT;replace;%2Fdocs%3Bpart")).toEqual({
      status: 307,
      type: "replace",
      url: "/docs;part",
    });
  });

  it("rejects malformed Next-style trailing status segments", () => {
    expect(parseNextRedirectDigest("NEXT_REDIRECT;replace;/foo;307garbage;")).toBeNull();
    expect(parseNextRedirectDigest("NEXT_REDIRECT;replace;/foo;abc;")).toBeNull();
    expect(parseNextRedirectDigest("NEXT_REDIRECT;replace;/foo;")).toBeNull();
  });
});
