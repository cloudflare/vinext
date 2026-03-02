import { describe, it, expect } from "vitest";
import {
  isAllowedDevOrigin,
  isCrossSiteNoCorsRequest,
  validateDevRequest,
  generateDevOriginCheckCode,
} from "../packages/vinext/src/server/dev-origin-check.js";

describe("dev origin check", () => {
  // ── isAllowedDevOrigin ────────────────────────────────────────────────

  describe("isAllowedDevOrigin", () => {
    it("allows requests with no Origin header", () => {
      expect(isAllowedDevOrigin(null, "localhost:5173")).toBe(true);
      expect(isAllowedDevOrigin(undefined, "localhost:5173")).toBe(true);
    });

    it("allows requests with Origin 'null' (sandboxed iframe, privacy)", () => {
      expect(isAllowedDevOrigin("null", "localhost:5173")).toBe(true);
    });

    it("allows localhost origins (any port)", () => {
      expect(isAllowedDevOrigin("http://localhost:5173", "localhost:5173")).toBe(true);
      expect(isAllowedDevOrigin("http://localhost:3000", "localhost:5173")).toBe(true);
      expect(isAllowedDevOrigin("http://localhost", "localhost:5173")).toBe(true);
      expect(isAllowedDevOrigin("https://localhost:8443", "localhost:5173")).toBe(true);
    });

    it("allows 127.0.0.1 origins", () => {
      expect(isAllowedDevOrigin("http://127.0.0.1:5173", "localhost:5173")).toBe(true);
      expect(isAllowedDevOrigin("http://127.0.0.1:3000", "localhost:5173")).toBe(true);
      expect(isAllowedDevOrigin("http://127.0.0.1", "localhost:5173")).toBe(true);
    });

    it("allows [::1] (IPv6 loopback) origins", () => {
      expect(isAllowedDevOrigin("http://[::1]:5173", "localhost:5173")).toBe(true);
      expect(isAllowedDevOrigin("http://[::1]", "localhost:5173")).toBe(true);
    });

    it("allows subdomains of localhost", () => {
      expect(isAllowedDevOrigin("http://storybook.localhost:6006", "localhost:5173")).toBe(true);
      expect(isAllowedDevOrigin("http://foo.localhost", "localhost:5173")).toBe(true);
      expect(isAllowedDevOrigin("http://a.b.localhost:3000", "localhost:5173")).toBe(true);
    });

    it("blocks external origins", () => {
      expect(isAllowedDevOrigin("https://evil.com", "localhost:5173")).toBe(false);
      expect(isAllowedDevOrigin("http://external.io:5173", "localhost:5173")).toBe(false);
      expect(isAllowedDevOrigin("https://google.com", "localhost:5173")).toBe(false);
    });

    it("blocks origins that look like localhost but aren't", () => {
      // "notlocalhost" should not match
      expect(isAllowedDevOrigin("http://notlocalhost:5173", "localhost:5173")).toBe(false);
      // "localhost.evil.com" should not match
      expect(isAllowedDevOrigin("http://localhost.evil.com", "localhost:5173")).toBe(false);
    });

    it("blocks malformed origin headers", () => {
      expect(isAllowedDevOrigin("not-a-url", "localhost:5173")).toBe(false);
      expect(isAllowedDevOrigin("javascript:alert(1)", "localhost:5173")).toBe(false);
    });

    it("allows same-origin by matching Host header", () => {
      // Origin hostname matches Host hostname
      expect(isAllowedDevOrigin("http://myapp.local:5173", "myapp.local:5173")).toBe(true);
      expect(isAllowedDevOrigin("http://192.168.1.5:3000", "192.168.1.5:3000")).toBe(true);
    });

    it("same-origin check ignores port differences", () => {
      // Hostname matches even though port differs
      expect(isAllowedDevOrigin("http://myapp.local:3000", "myapp.local:5173")).toBe(true);
    });

    it("same-origin check handles comma-separated Host header", () => {
      expect(isAllowedDevOrigin("http://myapp.local:3000", "myapp.local:5173, proxy:8080")).toBe(true);
    });

    it("allows origins in the allowedDevOrigins list", () => {
      const allowed = ["custom-origin.com", "*.my-domain.com"];
      expect(isAllowedDevOrigin("http://custom-origin.com:3000", "localhost:5173", allowed)).toBe(true);
      expect(isAllowedDevOrigin("http://sub.my-domain.com", "localhost:5173", allowed)).toBe(true);
      expect(isAllowedDevOrigin("http://my-domain.com", "localhost:5173", allowed)).toBe(true);
      expect(isAllowedDevOrigin("http://a.b.my-domain.com", "localhost:5173", allowed)).toBe(true);
    });

    it("rejects origins not in the allowedDevOrigins list", () => {
      const allowed = ["custom-origin.com"];
      expect(isAllowedDevOrigin("https://other.com", "localhost:5173", allowed)).toBe(false);
    });

    it("handles case-insensitive hostnames", () => {
      expect(isAllowedDevOrigin("http://LOCALHOST:5173", "localhost:5173")).toBe(true);
      expect(isAllowedDevOrigin("http://LocalHost:5173", "localhost:5173")).toBe(true);
    });
  });

  // ── isCrossSiteNoCorsRequest ──────────────────────────────────────────

  describe("isCrossSiteNoCorsRequest", () => {
    it("detects cross-site no-cors requests", () => {
      expect(isCrossSiteNoCorsRequest("cross-site", "no-cors")).toBe(true);
    });

    it("allows same-origin requests", () => {
      expect(isCrossSiteNoCorsRequest("same-origin", "cors")).toBe(false);
      expect(isCrossSiteNoCorsRequest("same-origin", "no-cors")).toBe(false);
    });

    it("allows same-site requests", () => {
      expect(isCrossSiteNoCorsRequest("same-site", "no-cors")).toBe(false);
    });

    it("allows cross-site CORS requests (fetch with mode:cors)", () => {
      expect(isCrossSiteNoCorsRequest("cross-site", "cors")).toBe(false);
    });

    it("handles missing headers", () => {
      expect(isCrossSiteNoCorsRequest(null, null)).toBe(false);
      expect(isCrossSiteNoCorsRequest(undefined, undefined)).toBe(false);
      expect(isCrossSiteNoCorsRequest("cross-site", null)).toBe(false);
    });
  });

  // ── validateDevRequest ────────────────────────────────────────────────

  describe("validateDevRequest", () => {
    it("allows requests with no Origin and no Sec-Fetch headers", () => {
      expect(validateDevRequest({ host: "localhost:5173" })).toBeNull();
    });

    it("allows localhost origin requests", () => {
      expect(validateDevRequest({
        origin: "http://localhost:5173",
        host: "localhost:5173",
      })).toBeNull();
    });

    it("blocks cross-site no-cors requests (script tag exfiltration)", () => {
      const result = validateDevRequest({
        origin: "https://evil.com",
        host: "localhost:5173",
        "sec-fetch-site": "cross-site",
        "sec-fetch-mode": "no-cors",
      });
      expect(result).not.toBeNull();
      expect(result).toContain("cross-site no-cors");
    });

    it("blocks cross-origin fetch requests", () => {
      const result = validateDevRequest({
        origin: "https://evil.com",
        host: "localhost:5173",
      });
      expect(result).not.toBeNull();
      expect(result).toContain("evil.com");
    });

    it("passes allowedDevOrigins to origin check", () => {
      expect(validateDevRequest(
        { origin: "http://custom.com", host: "localhost:5173" },
        ["custom.com"],
      )).toBeNull();
    });
  });

  // ── generateDevOriginCheckCode ────────────────────────────────────────

  describe("generateDevOriginCheckCode", () => {
    it("generates code with the validation function", () => {
      const code = generateDevOriginCheckCode();
      expect(code).toContain("__validateDevRequestOrigin");
      expect(code).toContain("__safeDevHosts");
      expect(code).toContain("sec-fetch-mode");
      expect(code).toContain("sec-fetch-site");
    });

    it("embeds allowed dev origins when provided", () => {
      const code = generateDevOriginCheckCode(["my-proxy.com", "*.staging.com"]);
      expect(code).toContain("my-proxy.com");
      expect(code).toContain("*.staging.com");
    });

    it("embeds empty array when no origins provided", () => {
      const code = generateDevOriginCheckCode();
      expect(code).toContain("__allowedDevOrigins = []");
    });
  });
});
