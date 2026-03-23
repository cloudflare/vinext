import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer, type ViteDevServer } from "vite-plus";
import vinext from "../packages/vinext/src/index.js";
import {
  createNextTypegenController,
  resolveNextTypegenBin,
} from "../packages/vinext/src/typegen.js";

function createTempProject(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(root: string, relativePath: string, content: string): void {
  const fullPath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, "utf8");
}

function readCount(root: string): number {
  const countFile = path.join(root, ".typegen-count");
  if (!fs.existsSync(countFile)) return 0;
  return Number(fs.readFileSync(countFile, "utf8"));
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for condition");
}

function setupPagesProject(root: string): void {
  writeFile(
    root,
    "package.json",
    JSON.stringify({
      name: "typegen-test",
      version: "1.0.0",
      dependencies: {
        react: "^19.2.0",
        "react-dom": "^19.2.0",
      },
    }),
  );
  writeFile(root, "pages/index.tsx", "export default function Page() { return <div>hi</div>; }\n");
}

/** Install a fake `next` binary that increments a counter file instead of running real typegen. */
function installFakeNext(root: string): void {
  writeFile(
    root,
    "node_modules/next/package.json",
    JSON.stringify({ name: "next", version: "15.0.0" }),
  );
  writeFile(
    root,
    "node_modules/next/dist/bin/next.js",
    `const fs = require("node:fs");
const path = require("node:path");
const countFile = path.join(process.cwd(), ".typegen-count");
const current = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, "utf8")) : 0;
fs.writeFileSync(countFile, String(current + 1));
`,
  );
}

async function startServer(
  root: string,
  typegen: boolean | undefined = undefined,
): Promise<ViteDevServer> {
  const server = await createServer({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [vinext({ appDir: root, typegen })],
    server: { port: 0 },
  });
  await server.listen();
  return server;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("next typegen controller", () => {
  it("resolves the local Next.js bin from the project root", () => {
    const root = createTempProject("vinext-typegen-bin-");
    try {
      setupPagesProject(root);
      installFakeNext(root);

      expect(resolveNextTypegenBin(root)).toBe(
        path.join(root, "node_modules/next/dist/bin/next.js"),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("logs once and skips when next is missing", async () => {
    const info = vi.fn();
    const controller = createNextTypegenController({
      root: "/tmp/no-next",
      logger: { info, warn: vi.fn() },
      resolveNextBin: () => null,
    });

    controller.start();
    controller.schedule();

    await waitFor(() => info.mock.calls.length === 1);
    expect(info).toHaveBeenCalledTimes(1);
  });
});

describe("vinext dev typegen integration", () => {
  it("invokes the project-local Next.js typegen command on dev server startup by default", async () => {
    const root = createTempProject("vinext-typegen-start-");
    let server: ViteDevServer | null = null;
    try {
      setupPagesProject(root);
      installFakeNext(root);

      server = await startServer(root);
      await waitFor(() => readCount(root) >= 1);

      expect(readCount(root)).toBeGreaterThanOrEqual(1);
    } finally {
      await server?.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("can disable automatic typegen", async () => {
    const root = createTempProject("vinext-typegen-disabled-");
    let server: ViteDevServer | null = null;
    try {
      setupPagesProject(root);
      installFakeNext(root);

      server = await startServer(root, false);
      await new Promise((resolve) => setTimeout(resolve, 400));

      expect(readCount(root)).toBe(0);
    } finally {
      await server?.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reruns the project-local Next.js typegen command when a route file is added", async () => {
    const root = createTempProject("vinext-typegen-watch-");
    let server: ViteDevServer | null = null;
    try {
      setupPagesProject(root);
      installFakeNext(root);

      server = await startServer(root);
      await waitFor(() => readCount(root) >= 1);

      writeFile(
        root,
        "pages/about.tsx",
        "export default function About() { return <div>about</div>; }\n",
      );

      await waitFor(() => readCount(root) >= 2);
      expect(readCount(root)).toBeGreaterThanOrEqual(2);
    } finally {
      await server?.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("starts cleanly when next is not installed", async () => {
    const root = createTempProject("vinext-typegen-missing-");
    let server: ViteDevServer | null = null;
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      setupPagesProject(root);

      server = await startServer(root);
      await new Promise((resolve) => setTimeout(resolve, 250));

      expect(info).toHaveBeenCalledWith(
        "[vinext] Skipping dev typegen: `next` is not installed in this project.",
      );
    } finally {
      await server?.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
