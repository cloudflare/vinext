import { describe, expect, it } from "vite-plus/test";
import { resolvePagesPageMethodResponse } from "../packages/vinext/src/server/pages-page-method.js";

describe("pages page method policy", () => {
  it("returns 405 with Allow for POST to a static (no gSSP) page", async () => {
    const response = resolvePagesPageMethodResponse({
      hasGetServerSideProps: false,
      method: "POST",
    });

    if (!response) {
      throw new Error("Expected a Method Not Allowed response");
    }
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
    await expect(response.text()).resolves.toBe("Method Not Allowed");
  });

  it.each(["PUT", "DELETE", "PATCH", "OPTIONS"])(
    "returns 405 for %s on a static page",
    (method) => {
      const response = resolvePagesPageMethodResponse({
        hasGetServerSideProps: false,
        method,
      });
      expect(response?.status).toBe(405);
    },
  );

  it.each(["GET", "HEAD", "get", "head"])("returns null for %s requests", (method) => {
    expect(
      resolvePagesPageMethodResponse({
        hasGetServerSideProps: false,
        method,
      }),
    ).toBeNull();
  });

  it("returns null when the page has getServerSideProps (SSR is allowed any method)", () => {
    expect(
      resolvePagesPageMethodResponse({
        hasGetServerSideProps: true,
        method: "POST",
      }),
    ).toBeNull();
  });
});
