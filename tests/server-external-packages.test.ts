import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import {
  findOpenTelemetryPackages,
  mergeServerExternalPackages,
} from "../packages/vinext/src/config/server-external-packages.js";

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

  it("preserves the OpenTelemetry hook package boundaries", () => {
    const defaults = mergeServerExternalPackages();

    expect(defaults).toContain("import-in-the-middle");
    expect(defaults).toContain("require-in-the-middle");
  });

  it("finds direct OpenTelemetry packages across runtime dependency fields", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-otel-packages-"));
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        dependencies: {
          "@opentelemetry/api": "1.9.0",
          react: "19.2.0",
        },
        devDependencies: { "@opentelemetry/sdk-node": "0.203.0" },
        optionalDependencies: { "@opentelemetry/exporter-jaeger": "2.0.1" },
        peerDependencies: { "@opentelemetry/resources": "2.0.1" },
      }),
    );

    try {
      expect(findOpenTelemetryPackages(root)).toEqual([
        "@opentelemetry/api",
        "@opentelemetry/sdk-node",
        "@opentelemetry/exporter-jaeger",
        "@opentelemetry/resources",
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("externalizes direct OpenTelemetry packages unless explicitly transpiled", () => {
    expect(
      mergeServerExternalPackages([], [], ["@opentelemetry/api", "@opentelemetry/instrumentation"]),
    ).toEqual(expect.arrayContaining(["@opentelemetry/api", "@opentelemetry/instrumentation"]));
    expect(
      mergeServerExternalPackages(
        [],
        ["@opentelemetry/instrumentation"],
        ["@opentelemetry/api", "@opentelemetry/instrumentation"],
      ),
    ).not.toContain("@opentelemetry/instrumentation");
  });

  it("rejects conflicts between explicit externals and transpiled packages", () => {
    expect(() => mergeServerExternalPackages(["typescript"], ["typescript"])).toThrow(
      "The packages specified in the 'transpilePackages' conflict with the 'serverExternalPackages': typescript",
    );
  });
});
