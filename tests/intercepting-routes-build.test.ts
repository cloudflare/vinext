import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBuilder } from "vite";
import { afterEach, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";

const tmpDirs: string[] = [];

function writeFixtureFile(root: string, filePath: string, content: string) {
  const absPath = path.join(root, filePath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content);
}

async function buildApp(root: string) {
  const builder = await createBuilder({
    root,
    configFile: false,
    plugins: [vinext({ appDir: root })],
    logLevel: "silent",
  });
  await builder.buildApp();
}

describe("App Router intercepting routes in production builds", () => {
  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("builds when an inherited modal slot intercepts the same target route as a standalone page", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-intercept-build-"));
    tmpDirs.push(root);

    fs.symlinkSync(
      path.resolve(import.meta.dirname, "../node_modules"),
      path.join(root, "node_modules"),
      "junction",
    );

    writeFixtureFile(
      root,
      "package.json",
      JSON.stringify({ name: "vinext-intercept-build", private: true, type: "module" }, null, 2),
    );
    writeFixtureFile(
      root,
      "tsconfig.json",
      JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "ESNext",
            moduleResolution: "bundler",
            jsx: "react-jsx",
            strict: true,
            skipLibCheck: true,
            types: ["vite/client", "@vitejs/plugin-rsc/types"],
          },
          include: ["app", "*.ts", "*.tsx"],
        },
        null,
        2,
      ),
    );
    writeFixtureFile(
      root,
      "app/layout.tsx",
      `import type { ReactNode } from "react";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
`,
    );
    writeFixtureFile(
      root,
      "app/page.tsx",
      `export default function HomePage() {
  return <main>home</main>;
}
`,
    );
    writeFixtureFile(
      root,
      "app/intercepting-routes/layout.tsx",
      `import type { ReactNode } from "react";

export default function InterceptingLayout({
  children,
  modal,
}: {
  children: ReactNode;
  modal: ReactNode;
}) {
  return (
    <>
      <div data-testid="gallery-shell">{children}</div>
      {modal}
    </>
  );
}
`,
    );
    writeFixtureFile(
      root,
      "app/intercepting-routes/page.tsx",
      `export default function GalleryPage() {
  return <main>gallery</main>;
}
`,
    );
    writeFixtureFile(
      root,
      "app/intercepting-routes/photo/[id]/page.tsx",
      `export default function PhotoPage() {
  return <main>standalone photo page</main>;
}
`,
    );
    writeFixtureFile(
      root,
      "app/intercepting-routes/@modal/default.tsx",
      `export default function ModalDefault() {
  return null;
}
`,
    );
    writeFixtureFile(
      root,
      "app/intercepting-routes/@modal/(.)photo/[id]/page.tsx",
      `export default function PhotoModalPage() {
  return <div>photo modal</div>;
}
`,
    );

    await buildApp(root);

    expect(fs.existsSync(path.join(root, "dist", "server", "index.js"))).toBe(true);
    expect(fs.existsSync(path.join(root, "dist", "server", "ssr", "index.js"))).toBe(true);
    expect(fs.existsSync(path.join(root, "dist", "client"))).toBe(true);
  }, 60_000);
});
