import { describe, expect, it } from "vite-plus/test";
import {
  getScriptNonceFromHeader,
  getScriptNonceFromHeaderSources,
  getScriptNonceFromNodeHeaderSources,
  getScriptNonceFromHeaders,
} from "../packages/vinext/src/server/csp.js";

describe("CSP nonce helpers", () => {
  it("extracts the nonce from script-src", () => {
    expect(
      getScriptNonceFromHeader("default-src 'self'; script-src 'self' 'nonce-test-nonce';"),
    ).toBe("test-nonce");
  });

  it("falls back to default-src when script-src is absent", () => {
    expect(getScriptNonceFromHeader("default-src 'nonce-test-nonce'")).toBe("test-nonce");
  });

  it("prefers script-src over default-src when both are present", () => {
    expect(
      getScriptNonceFromHeader(
        "default-src 'nonce-default'; script-src 'self' 'nonce-script'; style-src 'self'",
      ),
    ).toBe("script");
  });

  it("does not match script-src-* directives when resolving the script nonce", () => {
    expect(
      getScriptNonceFromHeader(
        "script-src-elem 'nonce-element'; script-src-attr 'nonce-attr'; script-src 'nonce-script'",
      ),
    ).toBe("script");
  });

  it("does not match default-src-* directives when falling back to default-src", () => {
    expect(
      getScriptNonceFromHeader(
        "default-src-elem 'nonce-element'; default-src-attr 'nonce-attr'; default-src 'nonce-default'",
      ),
    ).toBe("default");
  });

  it("parses the first matching nonce across extra whitespace and additional nonces", () => {
    expect(
      getScriptNonceFromHeader(
        "   script-src   'self'   'nonce-first'   'nonce-second'   'strict-dynamic' ",
      ),
    ).toBe("first");
  });

  it("returns undefined when script-src/default-src does not contain a valid nonce", () => {
    expect(getScriptNonceFromHeader("script-src 'nonce-'")).toBeUndefined();
    expect(getScriptNonceFromHeader("style-src 'nonce-test-nonce'")).toBeUndefined();
    expect(getScriptNonceFromHeader("")).toBeUndefined();
  });

  it("reads Content-Security-Policy-Report-Only when CSP is absent", () => {
    const headers = new Headers({
      "content-security-policy-report-only": "script-src 'nonce-test-nonce' 'strict-dynamic';",
    });

    expect(getScriptNonceFromHeaders(headers)).toBe("test-nonce");
  });

  it("prefers request CSP over fallback header sources", () => {
    const requestHeaders = new Headers({
      "content-security-policy": "script-src 'nonce-request-nonce' 'strict-dynamic';",
    });
    const middlewareHeaders = new Headers({
      "content-security-policy": "script-src 'nonce-response-nonce' 'strict-dynamic';",
    });

    expect(getScriptNonceFromHeaderSources(requestHeaders, middlewareHeaders)).toBe(
      "request-nonce",
    );
  });

  it("falls back to later header sources when request headers do not contain a nonce", () => {
    const requestHeaders = new Headers({
      "content-security-policy": "script-src 'self' 'strict-dynamic';",
    });
    const fallbackHeaders = new Headers({
      "content-security-policy-report-only": "script-src 'nonce-request-nonce' 'strict-dynamic';",
    });

    expect(getScriptNonceFromHeaderSources(requestHeaders, fallbackHeaders)).toBe("request-nonce");
  });

  it("reads the first nonce across Node request/response header sources without allocating Headers", () => {
    const requestHeaders = {
      "content-security-policy": "script-src 'self' 'strict-dynamic';",
    };
    const responseHeaders = {
      "content-security-policy-report-only": "script-src 'nonce-response-nonce' 'strict-dynamic';",
    };

    expect(getScriptNonceFromNodeHeaderSources(requestHeaders, responseHeaders)).toBe(
      "response-nonce",
    );
  });

  it("throws on HTML-escape characters using Next.js-compatible messaging", () => {
    expect(() => getScriptNonceFromHeader("script-src 'nonce-bad&nonce'")).toThrow(
      "Nonce value from Content-Security-Policy contained HTML escape characters.\nLearn more: https://nextjs.org/docs/messages/nonce-contained-invalid-characters",
    );
  });
});
