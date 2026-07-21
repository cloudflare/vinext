import { describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";

function getUseCacheTransform(): (code: string, id: string) => Promise<unknown> {
  const plugin = vinext().find(
    (candidate): candidate is Exclude<typeof candidate, false | null | undefined> =>
      typeof candidate === "object" &&
      candidate !== null &&
      Reflect.get(candidate, "name") === "vinext:use-cache",
  );
  expect(plugin).toBeDefined();

  const transform = plugin && "transform" in plugin ? plugin.transform : undefined;
  const handler =
    typeof transform === "object" && transform !== null && "handler" in transform
      ? transform.handler
      : transform;
  expect(typeof handler).toBe("function");

  return (code, id) =>
    (handler as (code: string, id: string) => Promise<unknown>).call({}, code, id);
}

describe('"use cache" transform argument metadata', () => {
  // Extends Next.js's cached generateMetadata parent-argument coverage to
  // default and rest parameter declarations:
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/use-cache/use-cache.test.ts
  it.each([
    {
      name: "a default parameter",
      source: `
export async function generateMetadata(_props, parent = fallbackParent) {
  "use cache";
  return { title: (await parent).description };
}
`,
    },
    {
      name: "a rest parameter",
      source: `
export async function generateMetadata(...args) {
  "use cache";
  return { title: (await args[1]).description };
}
`,
    },
  ])(
    "records that an inline cached function accepts the second argument with $name",
    async ({ source }) => {
      const transform = getUseCacheTransform();
      const result = (await transform(source, "/app/page.js")) as { code: string };

      expect(result.code).toContain("{ acceptsSecondArgument: true }");
    },
  );

  it("records file-level cached generateMetadata argument declarations", async () => {
    const transform = getUseCacheTransform();
    const result = (await transform(
      `
"use cache";
export async function generateMetadata(_props, parent = fallbackParent) {
  return { title: (await parent).description };
}
`,
      "/app/page.js",
    )) as { code: string };

    expect(result.code).toContain("{ acceptsSecondArgument: true }");
  });

  it("conservatively passes parent to an opaque file-level re-export", async () => {
    const transform = getUseCacheTransform();
    const result = (await transform(
      `
"use cache";
export { generateMetadata } from "./metadata.js";
`,
      "/app/page.js",
    )) as { code: string };

    // Next.js records all arguments as used when a cache export's declaration
    // cannot be analyzed in the current module.
    expect(result.code).toContain(
      'registerCachedFunction($$import_generateMetadata, "/app/page.js:generateMetadata", "", { acceptsSecondArgument: true })',
    );
  });

  it("records that a cached function without a declared parent omits the second argument", async () => {
    const transform = getUseCacheTransform();
    const result = (await transform(
      `
export async function generateMetadata() {
  "use cache";
  return { title: "Page" };
}
`,
      "/app/page.js",
    )) as { code: string };

    expect(result.code).toContain("{ acceptsSecondArgument: false }");
  });
});
