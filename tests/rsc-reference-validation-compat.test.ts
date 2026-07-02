import { describe, expect, it } from "vitest";
import { shouldAcceptDecodedViteRscReferenceValidation } from "../packages/vinext/src/plugins/rsc-reference-validation-compat.js";

function decodedViteRscReference(path: string): string {
  return `/@id/\0virtual:vite-rsc/${path}`;
}

function encodedViteRscReferenceKey(path: string): string {
  return `/@id/__x00__virtual:vite-rsc/${path}`;
}

describe("RSC reference validation compatibility", () => {
  it("accepts decoded plugin-rsc framework virtual references with matching metadata", () => {
    expect(
      shouldAcceptDecodedViteRscReferenceValidation(
        decodedViteRscReference("remove-duplicate-server-css"),
        [{ referenceKey: encodedViteRscReferenceKey("remove-duplicate-server-css") }],
      ),
    ).toBe(true);
  });

  it("accepts decoded client package proxy references with matching metadata", () => {
    expect(
      shouldAcceptDecodedViteRscReferenceValidation(
        decodedViteRscReference("client-package-proxy/next/image"),
        [{ referenceKey: encodedViteRscReferenceKey("client-package-proxy/next/image") }],
      ),
    ).toBe(true);
  });

  it("accepts decoded client-in-server package proxy references with matching metadata", () => {
    const source = encodeURIComponent(
      "/project/node_modules/vinext/dist/shims/app-router-scroll.js",
    );
    const proxyPath = `client-in-server-package-proxy/${source}`;

    expect(
      shouldAcceptDecodedViteRscReferenceValidation(decodedViteRscReference(proxyPath), [
        { referenceKey: encodedViteRscReferenceKey(proxyPath) },
      ]),
    ).toBe(true);
  });

  it("does not accept decoded virtual references that plugin-rsc has not recorded", () => {
    expect(
      shouldAcceptDecodedViteRscReferenceValidation(
        decodedViteRscReference("client-package-proxy/next/image"),
        [],
      ),
    ).toBe(false);
  });

  it("does not accept non-plugin-rsc reference IDs", () => {
    expect(
      shouldAcceptDecodedViteRscReferenceValidation("/app/client.tsx", [
        { referenceKey: "/app/client.tsx" },
      ]),
    ).toBe(false);
  });
});
