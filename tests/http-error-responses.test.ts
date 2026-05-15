/**
 * Tests for the shared HTTP error response helpers.
 *
 * The 404 body assertion verifies parity with Next.js, which writes
 * "This page could not be found" (no trailing period) as the plain-text
 * 404 body. Sources in .nextjs-ref:
 *   - packages/next/src/server/route-modules/pages/pages-handler.ts L121, L535
 *   - packages/next/src/build/templates/app-route.ts L170, L349
 *   - packages/next/src/build/templates/app-page.ts L701, L1043
 *   - packages/next/src/pages/_error.tsx L7  (`404: 'This page could not be found'`)
 */

import { describe, expect, it } from "vitest";
import {
  notFoundResponse,
  badRequestResponse,
  forbiddenResponse,
  methodNotAllowedResponse,
  internalServerErrorResponse,
  payloadTooLargeResponse,
} from "../packages/vinext/src/server/http-error-responses.js";

describe("notFoundResponse", () => {
  it("uses the Next.js-compatible plain-text body 'This page could not be found'", async () => {
    const response = notFoundResponse();
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("This page could not be found");
  });

  it("preserves caller-supplied headers", async () => {
    const response = notFoundResponse({
      headers: { "x-mw": "1" },
    });
    expect(response.headers.get("x-mw")).toBe("1");
  });
});

describe("other error response helpers (regression sanity)", () => {
  it("badRequestResponse returns 400 with 'Bad Request' body", async () => {
    const response = badRequestResponse();
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Bad Request");
  });

  it("forbiddenResponse returns 403 with 'Forbidden' body", async () => {
    const response = forbiddenResponse();
    expect(response.status).toBe(403);
    expect(await response.text()).toBe("Forbidden");
  });

  it("methodNotAllowedResponse returns 405 with Allow header", async () => {
    const response = methodNotAllowedResponse("GET, HEAD");
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET, HEAD");
    expect(await response.text()).toBe("Method Not Allowed");
  });

  it("payloadTooLargeResponse returns 413", async () => {
    const response = payloadTooLargeResponse();
    expect(response.status).toBe(413);
    expect(await response.text()).toBe("Payload Too Large");
  });

  it("internalServerErrorResponse returns 500 with canonical body by default", async () => {
    const response = internalServerErrorResponse();
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Internal Server Error");
  });
});
