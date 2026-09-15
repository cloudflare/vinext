import { describe, expect, it } from "vite-plus/test";
import {
  createPagesApiHandlerSpanDescriptor,
  createPagesDataSpanDescriptor,
} from "../packages/vinext/src/server/pages-execution-tracing.js";

describe("Pages execution tracing", () => {
  // Ported from Next.js: test/e2e/opentelemetry/instrumentation/opentelemetry.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/opentelemetry/instrumentation/opentelemetry.test.ts
  it.each([
    ["getServerSideProps", "Render.getServerSideProps"],
    ["getStaticProps", "Render.getStaticProps"],
  ] as const)("matches the stable Next.js %s span descriptor", (method, type) => {
    expect(createPagesDataSpanDescriptor(method, "/products/:slug")).toEqual({
      attributes: { "next.route": "/products/[slug]" },
      name: `${method} /products/[slug]`,
      type,
    });
  });

  it("matches the stable Next.js Pages API handler span descriptor", () => {
    expect(createPagesApiHandlerSpanDescriptor("/api/products/:slug")).toEqual({
      name: "executing api route (pages) /api/products/[slug]",
      type: "Node.runHandler",
    });
  });
});
