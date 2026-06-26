import { describe, expect, it } from "vitest";
import { mergeServerExternalPackages } from "../packages/vinext/src/config/server-external-packages.js";

describe("mergeServerExternalPackages", () => {
  it("includes Next.js defaults and appends unique user packages", () => {
    const packages = mergeServerExternalPackages(["typescript", "custom-package"]);

    expect(packages).toContain("shiki");
    expect(packages).toContain("ts-morph");
    expect(packages).toContain("typescript");
    expect(packages).toContain("custom-package");
    expect(packages.filter((name) => name === "typescript")).toHaveLength(1);
  });

  it("lets transpilePackages override default externals", () => {
    const packages = mergeServerExternalPackages([], ["typescript", "shiki"]);

    expect(packages).not.toContain("shiki");
    expect(packages).not.toContain("typescript");
  });

  it("lets default and optimized transpile packages override externals", () => {
    const packages = mergeServerExternalPackages([], ["geist", "shiki"]);

    expect(packages).not.toContain("shiki");
  });

  it("rejects conflicts between explicit externals and transpiled packages", () => {
    expect(() => mergeServerExternalPackages(["typescript"], ["typescript"])).toThrow(
      "The packages specified in the 'transpilePackages' conflict with the 'serverExternalPackages': typescript",
    );
  });
});
