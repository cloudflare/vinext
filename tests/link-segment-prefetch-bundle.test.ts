import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { build } from "vite";

describe("Cache Components Link scheduler bundle", () => {
  it("dead-strips the scheduler from builds with Cache Components disabled", async () => {
    const entry = path.resolve("packages/vinext/src/shims/link.tsx");
    const result = await build({
      configFile: false,
      logLevel: "silent",
      define: {
        "process.env.__NEXT_CACHE_COMPONENTS": "false",
        "process.env.NODE_ENV": JSON.stringify("production"),
      },
      build: {
        lib: { entry, formats: ["es"] },
        minify: "oxc",
        rolldownOptions: {
          // Bundle the scheduler with Link so this test exercises tree shaking,
          // while keeping Link's unrelated runtime dependencies external.
          external: (id) => !id.includes("link-segment-prefetch-scheduler"),
        },
        write: false,
      },
    });
    const outputs = (Array.isArray(result) ? result : [result]).flatMap((item) =>
      "output" in item ? item.output : [],
    );
    const emittedCode = outputs
      .filter((item) => item.type === "chunk")
      .map((item) => item.code)
      .join("\n");

    expect(emittedCode).not.toContain("registerUserInteractionListeners");
    expect(emittedCode).not.toContain("mostRecentIntentTask");
    expect(emittedCode).not.toContain("pointerdown");
    expect(emittedCode).not.toContain("link-segment-prefetch-scheduler");
  });
});
