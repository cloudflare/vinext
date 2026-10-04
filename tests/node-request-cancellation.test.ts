import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import { startProdServer } from "../packages/vinext/src/server/prod-server.js";

// Next.js: https://github.com/vercel/next.js/blob/canary/test/e2e/cancel-request/stream-cancel.test.ts
// Exercise the actual Node host; Request-only tests cannot detect a missing socket signal.
describe("App Router production request cancellation", () => {
  it.each(["pending", "stream", "upload"])("aborts a disconnected %s request", async (mode) => {
    const directory = await mkdtemp(path.join(tmpdir(), "vinext-cancel-"));
    const key = `__vinext_cancel_${randomUUID().replaceAll("-", "")}`;
    let server: Server | undefined;
    let observed: Request | undefined;
    let streamCancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    let entered!: () => void;
    const received = new Promise<void>((resolve) => {
      entered = resolve;
    });
    Reflect.set(globalThis, key, async (request: Request) => {
      observed = request;
      entered();
      if (mode === "pending") {
        await delay(100);
        return new Response("done");
      }
      if (mode === "upload") {
        try {
          await request.text();
        } catch {
          /* Client intentionally interrupts the body. */
        }
        return new Response("done");
      }
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data: start\n\n"));
            timer = setInterval(
              () => controller.enqueue(new TextEncoder().encode("data: tick\n\n")),
              10,
            );
          },
          cancel() {
            streamCancelled = true;
            clearInterval(timer);
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    try {
      await mkdir(path.join(directory, "server"));
      await mkdir(path.join(directory, "client"));
      await writeFile(path.join(directory, "package.json"), '{"type":"module"}');
      await writeFile(
        path.join(directory, "server/index.js"),
        `export default request => globalThis.${key}(request);`,
      );
      ({ server } = await startProdServer({
        outDir: directory,
        host: "127.0.0.1",
        port: 0,
        silent: true,
      }));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected TCP listener");
      const client = httpRequest({
        hostname: "127.0.0.1",
        port: address.port,
        path: "/probe",
        method: mode === "upload" ? "POST" : "GET",
        headers: mode === "upload" ? { "content-length": "100000" } : {},
      });
      client.on("error", () => {});
      const firstChunk = new Promise<void>((resolve) =>
        client.on("response", (res) => res.once("data", () => resolve())),
      );
      if (mode === "upload") client.write("partial");
      else client.end();
      await received;
      if (mode === "stream") await firstChunk;
      client.destroy();
      await expect.poll(() => observed?.signal.aborted).toBe(true);
      if (mode === "stream") await expect.poll(() => streamCancelled).toBe(true);
      // Let the delayed handler settle before removing its fixture.
      await delay(120);
    } finally {
      clearInterval(timer);
      if (server) {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server!.close((error) => (error ? reject(error) : resolve())),
        );
      }
      Reflect.deleteProperty(globalThis, key);
      await rm(directory, { recursive: true, force: true });
    }
  });
});
