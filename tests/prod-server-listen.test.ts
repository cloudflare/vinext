import { execFile } from "node:child_process";
import fs from "node:fs";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { startProdServer } from "../packages/vinext/src/server/prod-server.js";

const execFileAsync = promisify(execFile);
const cliPath = path.resolve(import.meta.dirname, "../packages/vinext/dist/cli.js");

const SERVER_ENTRIES = {
  app: ["server/index.js", "export default () => new Response('ok');"],
  pages: ["server/entry.js", "export const vinextConfig = {};"],
} as const;

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function createProject(router: keyof typeof SERVER_ENTRIES): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `vinext-prod-listen-${router}-`));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const [entry, source] = SERVER_ENTRIES[router];
  fs.mkdirSync(path.join(root, "dist/server"), { recursive: true });
  fs.mkdirSync(path.join(root, "dist/client"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
  fs.writeFileSync(path.join(root, "dist", entry), source);
  return root;
}

// Holds a loopback port so the production server's listen() fails with
// EADDRINUSE.
async function occupyPort(): Promise<number> {
  const blocker: Server = createServer();
  await new Promise<void>((resolve, reject) => {
    blocker.once("error", reject).listen(0, "127.0.0.1", resolve);
  });
  cleanups.push(() => new Promise<void>((resolve) => blocker.close(() => resolve())));
  const address = blocker.address();
  if (!address || typeof address === "string") throw new Error("blocker has no TCP address");
  return address.port;
}

describe("production server listen failures", () => {
  it.each(["app", "pages"] as const)(
    "rejects startProdServer() with the listen error for %s builds",
    async (router) => {
      const port = await occupyPort();
      await expect(
        startProdServer({
          outDir: path.join(createProject(router), "dist"),
          port,
          host: "127.0.0.1",
          silent: true,
        }),
      ).rejects.toMatchObject({ code: "EADDRINUSE", port });
    },
  );

  // A running server installs the socket-error backstop, which logs and
  // absorbs uncaught errors. An unhandled listen error used to land there, so
  // startup never settled and the process exited 0. `next start` exits 1.
  it("exits `vinext start` with code 1 when the port is in use", async () => {
    const port = await occupyPort();
    const env = { ...process.env };
    // The backstop is not installed under a test runner.
    Reflect.deleteProperty(env, "VITEST");
    Reflect.deleteProperty(env, "NODE_ENV");

    const result = await execFileAsync(
      process.execPath,
      [cliPath, "start", "--port", String(port), "--hostname", "127.0.0.1"],
      { cwd: createProject("app"), env, timeout: 15_000 },
    ).then(
      () => ({ code: 0, stderr: "" }),
      (error: { code?: number; stderr?: string }) => error,
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("EADDRINUSE");
  }, 20_000);
});

describe("production server NODE_ENV", () => {
  const prodServerPath = path.resolve(
    import.meta.dirname,
    "../packages/vinext/dist/server/prod-server.js",
  );

  // React picks its development or production build from NODE_ENV when it is
  // first loaded, so this runs in a fresh process. The server bundle loads
  // React the way a built one does, then reports NODE_ENV and the React build.
  async function serveFreshProcess(nodeEnv: string | undefined): Promise<string> {
    const root = createProject("app");
    fs.writeFileSync(
      path.join(root, "dist/server/index.js"),
      `import { createRequire } from "node:module";
const require = createRequire(${JSON.stringify(prodServerPath)});
require("react");
const reactBuilds = Object.keys(require.cache).filter((file) => /react\\.(development|production)\\.js$/.test(file));
const body = [String(process.env.NODE_ENV), ...reactBuilds.map((file) => file.split(/[\\\\/]/).pop())].join(" ");
export default () => new Response(body);
`,
    );
    fs.writeFileSync(
      path.join(root, "main.js"),
      `import { startProdServer } from ${JSON.stringify(pathToFileURL(prodServerPath).href)};
const { server } = await startProdServer({ outDir: "dist", port: 0, host: "127.0.0.1", silent: true });
const response = await fetch(\`http://127.0.0.1:\${server.address().port}/\`);
console.log(await response.text());
server.close();
`,
    );
    const env = { ...process.env };
    if (nodeEnv === undefined) Reflect.deleteProperty(env, "NODE_ENV");
    else Reflect.set(env, "NODE_ENV", nodeEnv);
    const { stdout } = await execFileAsync(process.execPath, ["main.js"], {
      cwd: root,
      env,
      timeout: 15_000,
    });
    return stdout.trim();
  }

  it("defaults to production before React loads, like `vinext start`", async () => {
    expect(await serveFreshProcess(undefined)).toBe("production react.production.js");
  }, 20_000);

  it("keeps an explicit NODE_ENV", async () => {
    expect(await serveFreshProcess("development")).toBe("development react.development.js");
  }, 20_000);
});
