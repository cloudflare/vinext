import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = process.cwd();
const FIXTURE_ROOT = path.join(ROOT, "tests/fixtures/multi-stage-http");
const VINEXT_CLI = path.join(ROOT, "packages/vinext/dist/cli.js");
const READY_PREFIX = "VINEXT_HTTP_STAGE_READY:";
const STAGE_TOKEN = "multi-stage-http-test-token";

type ManifestEntry = {
  dynamicImports?: string[];
  file: string;
  imports?: string[];
  isEntry?: boolean;
  src?: string;
};

type StageServer = {
  logs: string[];
  origin: string;
  process: ChildProcess;
};

let requestServer: StageServer;
let responseServer: StageServer;
let manifest: Record<string, ManifestEntry>;
let createdNodeModules = false;

function spawnAndWait(
  command: string,
  args: string[],
  env?: Record<string, string | undefined>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: FIXTURE_ROOT,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output: string[] = [];
    child.stdout?.on("data", (chunk) => output.push(String(chunk)));
    child.stderr?.on("data", (chunk) => output.push(String(chunk)));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve(output.join(""));
      else reject(new Error(`${command} exited with code ${code}\n${output.join("")}`));
    });
  });
}

function startStageServer(
  entry: string,
  port: number,
  env?: Record<string, string | undefined>,
): Promise<StageServer> {
  return new Promise((resolve, reject) => {
    const logs: string[] = [];
    const child = spawn(process.execPath, [entry], {
      cwd: FIXTURE_ROOT,
      env: { ...process.env, PORT: String(port), ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Timed out starting ${entry}\n${logs.join("")}`));
    }, 10_000);
    let pending = "";
    const onOutput = (chunk: Buffer) => {
      const text = String(chunk);
      logs.push(text);
      pending += text;
      const match = pending.match(/VINEXT_HTTP_STAGE_READY:(\d+)/);
      if (!match) return;
      clearTimeout(timeout);
      resolve({ logs, origin: `http://127.0.0.1:${match[1]}`, process: child });
    };
    child.stdout?.on("data", onOutput);
    child.stderr?.on("data", onOutput);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (!pending.includes(READY_PREFIX)) {
        reject(new Error(`${entry} exited with code ${code}\n${logs.join("")}`));
      }
    });
  });
}

function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Missing reserved HTTP stage address"));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

async function stopStageServer(server: StageServer | undefined): Promise<void> {
  if (!server || server.process.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => server.process.once("exit", () => resolve()));
  server.process.kill("SIGTERM");
  await exited;
}

function findEntry(sourceSuffix: string): [string, ManifestEntry] {
  const match = Object.entries(manifest).find(
    ([key, entry]) =>
      entry.isEntry && (key.endsWith(sourceSuffix) || entry.src?.endsWith(sourceSuffix)),
  );
  if (!match) throw new Error(`Missing built entry for ${sourceSuffix}`);
  return match;
}

function readClosure(root: string): { code: string; keys: Set<string> } {
  const keys = new Set<string>();
  const visit = (key: string) => {
    if (keys.has(key)) return;
    const entry = manifest[key];
    if (!entry) throw new Error(`Missing manifest entry ${key}`);
    keys.add(key);
    for (const imported of [...(entry.imports ?? []), ...(entry.dynamicImports ?? [])]) {
      visit(imported);
    }
  };
  visit(root);
  const serverRoot = path.join(FIXTURE_ROOT, "dist/server");
  return {
    code: [...keys]
      .map((key) => fs.readFileSync(path.join(serverRoot, manifest[key]!.file), "utf8"))
      .join("\n"),
    keys,
  };
}

function readStaticClosure(root: string): { code: string; keys: Set<string> } {
  const keys = new Set<string>();
  const visit = (key: string) => {
    if (keys.has(key)) return;
    const entry = manifest[key];
    if (!entry) throw new Error(`Missing manifest entry ${key}`);
    keys.add(key);
    for (const imported of entry.imports ?? []) visit(imported);
  };
  visit(root);
  const serverRoot = path.join(FIXTURE_ROOT, "dist/server");
  return {
    code: [...keys]
      .map((key) => fs.readFileSync(path.join(serverRoot, manifest[key]!.file), "utf8"))
      .join("\n"),
    keys,
  };
}

function renderToken(body: string): string {
  const token =
    body.match(/data-render-token="([a-f0-9-]+)"/)?.[1] ??
    body.match(/"data-render-token":"([a-f0-9-]+)"/)?.[1];
  if (!token) throw new Error("Missing HTTP stage render token");
  return token;
}

beforeAll(async () => {
  const fixtureNodeModules = path.join(FIXTURE_ROOT, "node_modules");
  if (!fs.existsSync(fixtureNodeModules)) {
    fs.symlinkSync(path.join(ROOT, "tests/fixtures/pages-basic/node_modules"), fixtureNodeModules);
    createdNodeModules = true;
  }
  const buildOutput = await spawnAndWait(process.execPath, [
    VINEXT_CLI,
    "build",
    "--prerender-all",
  ]);
  const manifestPath = path.join(FIXTURE_ROOT, "dist/server/.vite/manifest.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`HTTP stage build did not emit a server manifest\n${buildOutput}`);
  }
  manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, ManifestEntry>;
  const [, responseEntry] = findEntry("http-stage-response.ts");
  const [, requestEntry] = findEntry("http-stage-request.ts");
  const [requestPort, responsePort] = await Promise.all([reservePort(), reservePort()]);
  [requestServer, responseServer] = await Promise.all([
    startStageServer(path.join(FIXTURE_ROOT, "dist/server", requestEntry.file), requestPort, {
      VINEXT_RESPONSE_STAGE_ORIGIN: `http://127.0.0.1:${responsePort}`,
      VINEXT_STAGE_TOKEN: STAGE_TOKEN,
    }),
    startStageServer(path.join(FIXTURE_ROOT, "dist/server", responseEntry.file), responsePort, {
      VINEXT_REQUEST_STAGE_ORIGIN: `http://127.0.0.1:${requestPort}`,
      VINEXT_STAGE_TOKEN: STAGE_TOKEN,
    }),
  ]);
}, 60_000);

afterAll(async () => {
  await Promise.all([stopStageServer(requestServer), stopStageServer(responseServer)]);
  if (createdNodeModules) fs.rmSync(path.join(FIXTURE_ROOT, "node_modules"));
});

describe("generic HTTP multi-stage transport", () => {
  it("requires authentication on both internal stage endpoints", async () => {
    const [requestResponse, responseResponse] = await Promise.all([
      fetch(`${requestServer.origin}/__vinext_request_stage`, { method: "POST" }),
      fetch(`${responseServer.origin}/__vinext_response_stage`, { method: "POST" }),
    ]);

    expect(requestResponse.status).toBe(401);
    expect(responseResponse.status).toBe(401);
  });

  it("keeps renderer and user-route modules out of the request-stage dynamic closure", () => {
    expect(findEntry("virtual:vinext-rsc-entry")).toBeTruthy();
    expect(findEntry("http-stage-request.ts")).toBeTruthy();
    expect(findEntry("http-stage-response.ts")).toBeTruthy();

    const [requestKey] = findEntry("http-stage-request.ts");
    const { code, keys } = readClosure(requestKey);

    expect([...keys].some((key) => key.endsWith("pages/index.tsx"))).toBe(false);
    expect([...keys].some((key) => key.endsWith("pages/api/echo.ts"))).toBe(false);
    expect([...keys].some((key) => key.endsWith("app/app-stage/[slug]/page.tsx"))).toBe(false);
    expect([...keys].some((key) => key.includes("vinext-pages-response-entry"))).toBe(false);
    expect(code).not.toContain("react-dom/server");
    expect(code).not.toContain("react.client.reference");
    expect(code).not.toContain("App HTTP stage render-token:");
  });

  it("keeps renderers, React, and user routes out of the response-stage static closure", () => {
    const [responseKey] = findEntry("http-stage-response.ts");
    const { code, keys } = readStaticClosure(responseKey);

    expect([...keys].some((key) => key.startsWith("app/") || key.startsWith("pages/"))).toBe(false);
    expect([...keys].some((key) => key.includes("virtual_vinext-response-stage"))).toBe(false);
    expect(code).not.toContain("react-dom/server");
    expect(code).not.toContain("react.client.reference");
    expect(code).not.toContain("renderToReadableStream");
    expect(code).not.toContain("App HTTP stage render-token:");
  });

  it("streams and reuses a shared render below request-specific middleware", async () => {
    const url = `${requestServer.origin}/stream-${Date.now()}`;
    const first = await fetch(url, { headers: { "x-test-visitor": "visitor-a" } });
    const reader = first.body!.getReader();
    const firstChunk = await reader.read();
    const firstChunkAt = performance.now();
    const chunks = firstChunk.done ? [] : [firstChunk.value];
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      chunks.push(chunk.value);
    }
    const completedAt = performance.now();
    const firstBody = new TextDecoder().decode(
      chunks.length === 1 ? chunks[0] : Uint8Array.from(chunks.flatMap((chunk) => [...chunk])),
    );

    expect(first.status, firstBody).toBe(200);
    expect(first.headers.get("x-http-stage-cache")).toBe("MISS");
    expect(first.headers.get("x-http-stage-visitor")).toBe("visitor-a");
    expect(first.headers.get("x-http-request-stage-pid")).not.toBe(
      first.headers.get("x-http-response-stage-pid"),
    );
    expect(firstChunkAt).toBeLessThan(completedAt);
    expect(completedAt - firstChunkAt).toBeGreaterThanOrEqual(180);

    const second = await fetch(url, { headers: { "x-test-visitor": "visitor-b" } });
    const secondBody = await second.text();
    expect(second.status).toBe(200);
    expect(second.headers.get("x-http-stage-cache")).toBe("HIT");
    expect(second.headers.get("x-http-stage-visitor")).toBe("visitor-b");
    expect(renderToken(secondBody)).toBe(renderToken(firstBody));
  });

  it("reuses an App render below personalized middleware", async () => {
    const url = `${requestServer.origin}/app-stage/app-${Date.now()}`;
    const first = await fetch(url, { headers: { "x-test-visitor": "visitor-a" } });
    const firstBody = await first.text();
    const second = await fetch(url, { headers: { "x-test-visitor": "visitor-b" } });
    const secondBody = await second.text();

    expect(first.status, firstBody).toBe(200);
    expect(first.headers.get("x-http-stage-cache")).toBe("MISS");
    expect(first.headers.get("x-http-stage-visitor")).toBe("visitor-a");
    expect(second.status, secondBody).toBe(200);
    expect(second.headers.get("x-http-stage-cache")).toBe("HIT");
    expect(second.headers.get("x-http-stage-visitor")).toBe("visitor-b");
    expect(renderToken(secondBody)).toBe(renderToken(firstBody));
  });

  it("keeps rewritten source identities distinct while reusing each one", async () => {
    const slug = `rewrite-${Date.now()}`;
    const rewritten = await fetch(`${requestServer.origin}/alias-${slug}`, {
      headers: { "x-test-visitor": "alias" },
    });
    const rewrittenBody = await rewritten.text();
    const direct = await fetch(`${requestServer.origin}/${slug}`, {
      headers: { "x-test-visitor": "direct" },
    });
    const directBody = await direct.text();

    expect(rewritten.status, rewrittenBody).toBe(200);
    expect(rewritten.headers.get("x-http-stage-cache")).toBe("MISS");
    expect(rewritten.headers.get("x-http-stage-visitor")).toBe("alias");
    expect(direct.status, directBody).toBe(200);
    expect(direct.headers.get("x-http-stage-cache")).toBe("MISS");
    expect(direct.headers.get("x-http-stage-visitor")).toBe("direct");
    expect(renderToken(directBody)).not.toBe(renderToken(rewrittenBody));

    const rewrittenHit = await fetch(`${requestServer.origin}/alias-${slug}`);
    const directHit = await fetch(`${requestServer.origin}/${slug}`);
    expect(rewrittenHit.headers.get("x-http-stage-cache")).toBe("HIT");
    expect(directHit.headers.get("x-http-stage-cache")).toBe("HIT");
    expect(renderToken(await rewrittenHit.text())).toBe(renderToken(rewrittenBody));
    expect(renderToken(await directHit.text())).toBe(renderToken(directBody));
  });

  it("routes res.revalidate() back through the remote request stage", async () => {
    const path = `/revalidate-${Date.now()}`;
    const first = await fetch(`${requestServer.origin}${path}`);
    const firstBody = await first.text();
    const cached = await fetch(`${requestServer.origin}${path}`);
    const cachedBody = await cached.text();

    expect(first.headers.get("x-http-stage-cache")).toBe("MISS");
    expect(first.headers.get("cache-tag")).toContain(`_N_T_${path}`);
    expect(cached.headers.get("x-http-stage-cache")).toBe("HIT");
    expect(renderToken(cachedBody)).toBe(renderToken(firstBody));

    const revalidated = await fetch(
      `${requestServer.origin}/api/revalidate?path=${encodeURIComponent(path)}`,
    );
    expect(revalidated.status, await revalidated.clone().text()).toBe(200);
    expect(revalidated.headers.get("x-http-stage-cache")).toBe("BYPASS");
    expect(await revalidated.json()).toEqual({ revalidated: true });

    const refreshed = await fetch(`${requestServer.origin}${path}`);
    const refreshedBody = await refreshed.text();
    expect(refreshed.status, refreshedBody).toBe(200);
    expect(refreshed.headers.get("x-http-stage-cache")).toBe("MISS");
    expect(renderToken(refreshedBody)).not.toBe(renderToken(firstBody));

    const refreshedHit = await fetch(`${requestServer.origin}${path}`);
    expect(refreshedHit.headers.get("x-http-stage-cache")).toBe("HIT");
    expect(renderToken(await refreshedHit.text())).toBe(renderToken(refreshedBody));
  });

  it("preserves Pages HEAD rendering without poisoning the GET representation", async () => {
    const url = `${requestServer.origin}/head-${Date.now()}`;
    const head = await fetch(url, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("x-http-stage-cache")).toBe("MISS");
    expect(await head.text()).toBe("");

    const get = await fetch(url);
    expect(get.status).toBe(200);
    expect(get.headers.get("x-http-stage-cache")).toBe("MISS");
    expect(renderToken(await get.text())).toBeTruthy();

    const getHit = await fetch(url);
    expect(getHit.headers.get("x-http-stage-cache")).toBe("HIT");
  });

  it("sends bypass POST requests to the remote response process", async () => {
    const post = async (visitor: string, value: string) => {
      const response = await fetch(`${requestServer.origin}/api/echo`, {
        body: JSON.stringify({ value }),
        headers: {
          "content-type": "application/json",
          "x-test-visitor": visitor,
        },
        method: "POST",
      });
      const text = await response.text();
      let body: {
        body: { value: string };
        renderToken: string;
      };
      try {
        body = JSON.parse(text) as typeof body;
      } catch {
        throw new Error(`Unexpected POST response (${response.status}): ${text}`);
      }
      return {
        body,
        headers: response.headers,
        status: response.status,
      };
    };

    const first = await post("visitor-a", "first");
    const second = await post("visitor-b", "second");
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.headers.get("x-http-stage-cache")).toBe("BYPASS");
    expect(second.headers.get("x-http-stage-cache")).toBe("BYPASS");
    expect(first.headers.get("x-http-response-stage-pid")).toBeTruthy();
    expect(first.headers.get("x-http-request-stage-pid")).not.toBe(
      first.headers.get("x-http-response-stage-pid"),
    );
    expect(first.headers.get("x-http-stage-visitor")).toBe("visitor-a");
    expect(second.headers.get("x-http-stage-visitor")).toBe("visitor-b");
    expect(first.body.body).toEqual({ value: "first" });
    expect(second.body.body).toEqual({ value: "second" });
    expect(second.body.renderToken).not.toBe(first.body.renderToken);
  });

  it("resolves full-graph public file signals after an HTTP stage round trip", async () => {
    const url = `${requestServer.origin}/stage-asset.txt`;
    const get = await fetch(url, {
      headers: { "cache-control": "no-cache", "x-test-visitor": "asset-get" },
    });
    expect(get.status).toBe(200);
    expect(get.headers.get("x-http-stage-cache")).toBe("BYPASS");
    expect(get.headers.get("x-http-stage-visitor")).toBe("asset-get");
    expect(get.headers.get("content-encoding")).toBeNull();
    expect(get.headers.get("content-length")).toBe(
      String(Buffer.byteLength("HTTP_STAGE_PUBLIC_ASSET\n")),
    );
    expect(get.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(get.headers.get("transfer-encoding")).toBeNull();
    expect(get.headers.get("x-http-request-stage-pid")).not.toBe(
      get.headers.get("x-http-response-stage-pid"),
    );
    await expect(get.text()).resolves.toBe("HTTP_STAGE_PUBLIC_ASSET\n");

    const head = await fetch(url, {
      headers: { "cache-control": "no-cache", "x-test-visitor": "asset-head" },
      method: "HEAD",
    });
    expect(head.status).toBe(200);
    expect(head.headers.get("x-http-stage-cache")).toBe("BYPASS");
    expect(head.headers.get("x-http-stage-visitor")).toBe("asset-head");
    expect(head.headers.get("content-length")).toBe(
      String(Buffer.byteLength("HTTP_STAGE_PUBLIC_ASSET\n")),
    );
    await expect(head.text()).resolves.toBe("");

    // Matches Next.js static-file method handling:
    // https://github.com/vercel/next.js/blob/canary/test/production/pages-dir/production/test/index.test.ts
    const post = await fetch(url, { method: "POST" });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD");
    await expect(post.text()).resolves.toBe("Method Not Allowed");
  });

  it("does not trust a user response carrying the stage signal header", async () => {
    const response = await fetch(`${requestServer.origin}/api/forged-stage-signal`, {
      headers: { "cache-control": "no-cache" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-http-stage-cache")).toBe("BYPASS");
    expect(response.headers.get("x-vinext-stage-static-file")).toBeNull();
    await expect(response.text()).resolves.toBe("forged stage signal stayed user content");
  });
});
