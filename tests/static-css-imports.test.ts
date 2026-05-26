import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { collectStandaloneCssImports } from "../packages/vinext/src/utils/static-css-imports.js";

describe("collectStandaloneCssImports", () => {
  it("follows static imports, re-exports, TS .js specifiers, and tsconfig aliases", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-static-css-imports-"));
    try {
      fs.mkdirSync(path.join(root, "app"), { recursive: true });
      fs.mkdirSync(path.join(root, "src"), { recursive: true });

      fs.writeFileSync(
        path.join(root, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            paths: {
              "@/*": ["src/*"],
            },
          },
        }),
      );
      fs.writeFileSync(
        path.join(root, "app", "global-not-found.tsx"),
        [
          'import "./entry.css";',
          'export { palette } from "./barrel.js";',
          'import "@/aliased";',
          "",
        ].join("\n"),
      );
      fs.writeFileSync(path.join(root, "app", "entry.css"), "body { color: red; }\n");
      fs.writeFileSync(
        path.join(root, "app", "barrel.ts"),
        ['export * from "./theme";', 'export type { Palette } from "./types";', ""].join("\n"),
      );
      fs.writeFileSync(
        path.join(root, "app", "theme.ts"),
        ['import "./theme.css";', 'export const palette = "green";', ""].join("\n"),
      );
      fs.writeFileSync(path.join(root, "app", "theme.css"), "body { color: green; }\n");
      fs.writeFileSync(path.join(root, "app", "types.ts"), 'import "./ignored-type.css";\n');
      fs.writeFileSync(path.join(root, "app", "ignored-type.css"), "body { color: black; }\n");
      fs.writeFileSync(path.join(root, "src", "aliased.ts"), 'import "./aliased.css";\n');
      fs.writeFileSync(path.join(root, "src", "aliased.css"), "body { color: blue; }\n");

      expect(collectStandaloneCssImports(path.join(root, "app", "global-not-found.tsx"))).toEqual([
        path.join(root, "app", "entry.css"),
        path.join(root, "app", "theme.css"),
        path.join(root, "src", "aliased.css"),
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
