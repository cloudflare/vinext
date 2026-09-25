import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  getDevStaticFileServerStorage,
  serveDevPublicFile,
} from "../packages/vinext/src/server/dev-static-file-server.js";
import { resolveDevStaticFileSignal } from "../packages/vinext/src/server/dev-static-file-signal.js";
import { createStaticFileSignal } from "../packages/vinext/src/server/static-file-signal.js";

let publicDir: string;

beforeAll(async () => {
  publicDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-dev-static-file-"));
  await fsp.writeFile(path.join(publicDir, "file.txt"), "hello from file.txt");
  await fsp.writeFile(path.join(publicDir, "..dotted.txt"), "dotted");
  await fsp.writeFile(path.join(publicDir, "script.ts"), "export {};");
  await fsp.writeFile(path.join(publicDir, "page.html"), "<p>hi</p>");
  await fsp.writeFile(path.join(publicDir, "hello copy.txt"), "spaced");
  await fsp.writeFile(path.join(publicDir, "logo%2Fdark.txt"), "percent");
  await fsp.mkdir(path.join(publicDir, "dir"));
  await fsp.writeFile(path.join(path.dirname(publicDir), "outside.txt"), "outside");
});

afterAll(async () => {
  await fsp.rm(publicDir, { recursive: true, force: true });
  await fsp.rm(path.join(path.dirname(publicDir), "outside.txt"), { force: true });
});

function request(init?: RequestInit): Request {
  return new Request("http://localhost/file.txt", init);
}

describe("serveDevPublicFile", () => {
  it("serves public files like Vite's dev public middleware", async () => {
    const response = await serveDevPublicFile(publicDir, "/file.txt", request());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain");
    expect(response.headers.get("content-length")).toBe("19");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(response.headers.get("etag")).toMatch(/^W\/"19-\d+"$/);
    await expect(response.text()).resolves.toBe("hello from file.txt");
  });

  it.each([
    ["/script.ts", "text/javascript"],
    ["/page.html", "text/html;charset=utf-8"],
  ])("uses Vite's public-file content type for %s", async (pathname, contentType) => {
    const response = await serveDevPublicFile(publicDir, pathname, request());

    expect(response.headers.get("content-type")).toBe(contentType);
  });

  it("applies Vite server.headers over generated headers", async () => {
    const response = await serveDevPublicFile(publicDir, "/file.txt", request(), {
      "Cache-Control": "max-age=60",
      "Content-Security-Policy": "default-src 'none'",
      "X-Multi": ["a", "b"],
    });

    expect(response.headers.get("cache-control")).toBe("max-age=60");
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'");
    expect(response.headers.get("x-multi")).toBe("a, b");
  });

  it("serves in-root names that begin with two dots", async () => {
    const response = await serveDevPublicFile(publicDir, "/..dotted.txt", request());

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("dotted");
  });

  it.each([
    ["/hello%20copy.txt", "spaced"],
    ["/logo%252Fdark.txt", "percent"],
  ])("decodes the encoded route %s once like Vite", async (pathname, body) => {
    const response = await serveDevPublicFile(publicDir, pathname, request());

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe(body);
  });

  it("omits the body for HEAD requests", async () => {
    const response = await serveDevPublicFile(publicDir, "/file.txt", request({ method: "HEAD" }));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe("19");
    await expect(response.text()).resolves.toBe("");
  });

  it("answers matching conditional requests with 304", async () => {
    const first = await serveDevPublicFile(publicDir, "/file.txt", request());
    const etag = first.headers.get("etag")!;

    const response = await serveDevPublicFile(
      publicDir,
      "/file.txt",
      request({ headers: { "if-none-match": etag } }),
    );

    expect(response.status).toBe(304);
    await expect(response.text()).resolves.toBe("");
  });

  it("serves single byte ranges", async () => {
    const response = await serveDevPublicFile(
      publicDir,
      "/file.txt",
      request({ headers: { range: "bytes=0-4" } }),
    );

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 0-4/19");
    await expect(response.text()).resolves.toBe("hello");

    const suffix = await serveDevPublicFile(
      publicDir,
      "/file.txt",
      request({ headers: { range: "bytes=-3" } }),
    );
    expect(suffix.headers.get("content-range")).toBe("bytes 16-18/19");
    await expect(suffix.text()).resolves.toBe("txt");
  });

  it("rejects unsatisfiable byte ranges", async () => {
    const response = await serveDevPublicFile(
      publicDir,
      "/file.txt",
      request({ headers: { range: "bytes=100-200" } }),
    );

    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */19");
  });

  it.each(["/missing.txt", "/dir", "/../outside.txt", "/..", "/%E0%A4%A.txt"])(
    "returns 404 for %s",
    async (pathname) => {
      const response = await serveDevPublicFile(publicDir, pathname, request());

      expect(response.status).toBe(404);
    },
  );
});

describe("resolveDevStaticFileSignal", () => {
  it("leaves signals untouched outside a dev host request scope", async () => {
    const signal = createStaticFileSignal("/file.txt", { headers: null, status: null });

    await expect(resolveDevStaticFileSignal(signal, request())).resolves.toBe(signal);
  });

  it("serves signalled files through the dev host request scope", async () => {
    const signal = createStaticFileSignal("/file.txt", {
      headers: new Headers({ "x-middleware": "kept" }),
      status: null,
    });

    const response = await getDevStaticFileServerStorage().run(
      (pathname, fileRequest) => serveDevPublicFile(publicDir, pathname, fileRequest),
      () => resolveDevStaticFileSignal(signal, request()),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware")).toBe("kept");
    await expect(response.text()).resolves.toBe("hello from file.txt");
  });
});
