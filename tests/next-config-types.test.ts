import path from "node:path";
import { API } from "typescript/unstable/sync";
import { describe, expect, it } from "vite-plus/test";

// This fixture uses `vinext/types` without `next` installed, as a vinext app does.
const FIXTURE_DIR = path.resolve(import.meta.dirname, "fixtures/app-router-nitro-server");

describe("next.config consumer types", () => {
  // Next.js v16.4 options: packages/next/src/server/config-shared.ts
  it("accepts instrumentation-client options through the public next import", () => {
    const file = path.join(FIXTURE_DIR, "next-config-types.ts");
    const api = new API({ cwd: FIXTURE_DIR });
    try {
      const snapshot = api.updateSnapshot({ openFiles: [file] });
      try {
        const project = snapshot.getDefaultProjectForFile(file);
        if (!project) throw new Error("Expected a TypeScript project for next-config-types.ts");
        expect(project.program.getSemanticDiagnostics(file).map((d) => d.text)).toEqual([]);
      } finally {
        snapshot.dispose();
      }
    } finally {
      api.close();
    }
  });
});
