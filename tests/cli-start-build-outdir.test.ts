import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { recordBuildOutDir } from "../packages/vinext/src/build/output-dir-record.js";

const cliPath = path.resolve(import.meta.dirname, "../packages/vinext/dist/cli.js");

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

// App Router server entries that answer with the build they belong to.
function writeBuild(root: string, outDir: string): void {
  fs.mkdirSync(path.join(root, outDir, "server"), { recursive: true });
  fs.mkdirSync(path.join(root, outDir, "client"), { recursive: true });
  fs.writeFileSync(
    path.join(root, outDir, "server/index.js"),
    `export default () => new Response(${JSON.stringify(outDir)});`,
  );
}

async function findFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject).listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!address || typeof address === "string") throw new Error("server has no TCP address");
  return address.port;
}

async function readServedBuild(root: string): Promise<string> {
  const port = await findFreePort();
  const child: ChildProcess = spawn(
    process.execPath,
    [cliPath, "start", "--port", String(port), "--hostname", "127.0.0.1"],
    { cwd: root, stdio: "ignore" },
  );
  cleanups.push(() => child.kill());

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`vinext start exited with ${child.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      return await response.text();
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("vinext start did not answer in time");
}

describe("vinext start build.outDir", () => {
  it("serves the build output the last build recorded, not a stale dist", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-start-outdir-"));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
    writeBuild(root, "dist");
    writeBuild(root, "out");
    recordBuildOutDir(root, path.join(root, "out"));

    expect(await readServedBuild(root)).toBe("out");
  }, 20_000);
});
