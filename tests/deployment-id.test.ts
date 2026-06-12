import { describe, expect, it } from "vite-plus/test";
import { appendDeploymentIdQuery } from "../packages/vinext/src/utils/deployment-id.js";

describe("appendDeploymentIdQuery", () => {
  it("inserts the deployment query before URL fragments", () => {
    expect(appendDeploymentIdQuery("/_next/static/chunk.js#module", "dpl_123")).toBe(
      "/_next/static/chunk.js?dpl=dpl_123#module",
    );
  });

  it("preserves existing queries and fragments", () => {
    expect(appendDeploymentIdQuery("/_next/static/chunk.js?v=1#module", "dpl_123")).toBe(
      "/_next/static/chunk.js?v=1&dpl=dpl_123#module",
    );
  });

  it("does not append a duplicate deployment query", () => {
    expect(appendDeploymentIdQuery("/_next/static/chunk.js?dpl=existing#module", "dpl_123")).toBe(
      "/_next/static/chunk.js?dpl=existing#module",
    );
  });
});
