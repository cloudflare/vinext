import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

const cliPath = path.resolve(import.meta.dirname, "../packages/vinext/dist/cli.js");

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

// An App Router build whose server entry answers with the NODE_ENV it runs
// under. React and react-dom stay external in the server build, so this is
// the value that picks their development or production builds.
function createProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-start-node-env-"));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "dist/server"), { recursive: true });
  fs.mkdirSync(path.join(root, "dist/client"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
  fs.writeFileSync(
    path.join(root, "dist/server/index.js"),
    'export default () => new Response(process.env.NODE_ENV ?? "unset");',
  );
  return root;
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

async function readNodeEnvFromStart(nodeEnv: "test" | undefined): Promise<string> {
  const port = await findFreePort();
  const env = { ...process.env };
  if (nodeEnv === undefined) Reflect.deleteProperty(env, "NODE_ENV");
  else env.NODE_ENV = nodeEnv;

  const child: ChildProcess = spawn(
    process.execPath,
    [cliPath, "start", "--port", String(port), "--hostname", "127.0.0.1"],
    { cwd: createProject(), env, stdio: "ignore" },
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

describe("vinext start NODE_ENV", () => {
  // `next start` defaults NODE_ENV to production and keeps a caller's value.
  // https://github.com/vercel/next.js/blob/canary/packages/next/src/bin/next.ts
  it("defaults NODE_ENV to production", async () => {
    expect(await readNodeEnvFromStart(undefined)).toBe("production");
  }, 20_000);

  it("keeps the caller's NODE_ENV", async () => {
    expect(await readNodeEnvFromStart("test")).toBe("test");
  }, 20_000);
});
