import { describe, expect, it } from "vite-plus/test";
import { createWorkerDeploymentIdDefinePlugin } from "../packages/vinext/src/plugins/worker-image-imports.js";

// Directly exercise the transform handler (Rollup plugin object) with a sample
// worker script; assert the deployment-id member accesses are inlined.
function runTransform(plugin: any, code: string, id = "/app/w.ts"): string | null {
  const t = plugin.transform;
  const handler = typeof t === "function" ? t : t.handler;
  const result = handler.call({}, code, id);
  return result == null ? null : typeof result === "string" ? result : result.code;
}

describe("worker deployment-id define", () => {
  const src = "self.onmessage = () => self.postMessage(process.env.NEXT_DEPLOYMENT_ID);";

  it("inlines the configured deployment id into worker scripts", () => {
    const out = runTransform(
      createWorkerDeploymentIdDefinePlugin({ deploymentId: "dep-123" }),
      src,
    );
    expect(out).toContain('"dep-123"');
    expect(out).not.toContain("process.env.NEXT_DEPLOYMENT_ID");
  });

  it("inlines `false` when no deployment id is configured (Next.js parity)", () => {
    const out = runTransform(createWorkerDeploymentIdDefinePlugin({}), src);
    expect(out).toContain("false");
    expect(out).not.toContain("process.env.NEXT_DEPLOYMENT_ID");
  });

  it("inlines the internal id identifier too", () => {
    const out = runTransform(
      createWorkerDeploymentIdDefinePlugin({ deploymentId: "dep-123" }),
      "self.postMessage(process.env.__VINEXT_DEPLOYMENT_ID);",
    );
    expect(out).toContain('"dep-123"');
    expect(out).not.toContain("process.env.__VINEXT_DEPLOYMENT_ID");
  });

  it("is a no-op for worker scripts that never read the id", () => {
    const out = runTransform(
      createWorkerDeploymentIdDefinePlugin({ deploymentId: "dep-123" }),
      "self.postMessage(1);",
    );
    expect(out).toBeNull();
  });
});
