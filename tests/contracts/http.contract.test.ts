import { afterAll, describe, expect, it } from "vitest";
import { closeContractServer, getContractServer } from "./_helpers";

// Ported from Next.js metadata and middleware behavior coverage:
// - test/e2e/app-dir/metadata/metadata.test.ts
// - test/e2e/vary-header/test/index.test.ts
// - test/e2e/middleware-request-header-overrides/test/index.test.ts

describe("shared HTTP contracts", () => {
  afterAll(async () => {
    await closeContractServer();
  });

  it("cookies() is mutable in route handlers", async () => {
    const { baseUrl } = await getContractServer();
    const res = await fetch(`${baseUrl}/contracts/api/cookies-mutable`);
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("contract-test=value");
  });

  it("headers() remains read-only in request-bound contexts", async () => {
    const { baseUrl } = await getContractServer();
    const res = await fetch(`${baseUrl}/contracts/api/headers-readonly`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.readonlyEnforced).toBe(true);
  });

  it("middleware response headers propagate to the final response", async () => {
    const { baseUrl } = await getContractServer();
    const res = await fetch(`${baseUrl}/contracts/api/middleware-headers`);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-mw-ran")).toBe("true");
    expect(res.headers.get("x-mw-pathname")).toBe("/contracts/api/middleware-headers");
  });

  it("title templates apply from parent layouts to child routes", async () => {
    const { baseUrl } = await getContractServer();
    const res = await fetch(`${baseUrl}/contracts/metadata-merge/extra`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Merge Test | Contracts");
  });
});
