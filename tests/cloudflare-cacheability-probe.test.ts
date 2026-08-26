import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { probeStagedWorkerCacheability } from "../packages/cloudflare/src/cacheability-probe.js";
import { VINEXT_CDN_BUILD_ID_HEADER } from "../packages/cloudflare/src/cache/cdn-build-id.js";
import { cacheabilityRequestIdentity } from "../packages/vinext/src/server/cacheability-manifest.js";
import {
  VINEXT_CACHEABILITY_PROBE_HEADER,
  VINEXT_CACHEABILITY_PROBE_QUERY_PARAM,
  VINEXT_PRERENDER_SECRET_HEADER,
} from "../packages/vinext/src/server/headers.js";

describe("staged Worker cacheability probes", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { force: true, recursive: true });
  });

  it("cancels stale Worker bodies before retrying with a hidden request key", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-cacheability-probe-"));
    roots.push(root);
    fs.mkdirSync(path.join(root, "dist", "server"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "dist", "server", "vinext-server.json"),
      JSON.stringify({ prerenderSecret: "probe-secret" }),
    );

    const urls: URL[] = [];
    let cancelledBodies = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      urls.push(url);
      const headers = new Headers(init?.headers);
      expect(headers.get(VINEXT_CACHEABILITY_PROBE_HEADER)).toBe("1");
      expect(headers.get(VINEXT_PRERENDER_SECRET_HEADER)).toBe("probe-secret");

      if (urls.length <= 2) {
        return new Response(
          new ReadableStream({
            cancel() {
              cancelledBodies++;
            },
          }),
          { headers: { [VINEXT_CDN_BUILD_ID_HEADER]: "old-response-build" } },
        );
      }
      return Response.json(
        {
          kind: "app-page",
          pattern: "/cached/:slug",
          state: "static-candidate",
          status: 200,
          version: 1,
        },
        { headers: { [VINEXT_CDN_BUILD_ID_HEADER]: "response-build" } },
      );
    });

    const target = {
      headers: { Accept: "text/html" },
      kind: "html" as const,
      label: "/cached/intro",
      pathname: "/cached/intro",
      sourcePathname: "/cached/intro",
    };
    const result = await probeStagedWorkerCacheability({
      buildId: "application-build",
      expectedResponseBuildId: "response-build",
      fetchImpl,
      retries: 2,
      retryDelayMs: 0,
      root,
      targetUrl: "https://example.com",
      targets: [target],
    });

    expect(result.failures).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(cancelledBodies).toBe(2);
    expect(urls.map((url) => url.pathname)).toEqual([
      "/cached/intro",
      "/cached/intro",
      "/cached/intro",
    ]);
    const nonces = urls.map((url) => url.searchParams.get(VINEXT_CACHEABILITY_PROBE_QUERY_PARAM));
    expect(nonces[0]).toBeTruthy();
    expect(nonces[1]).toBeTruthy();
    expect(nonces[0]).not.toBe(nonces[1]);
    expect(nonces[1]).not.toBe(nonces[2]);

    const route = Object.values(result.manifest.routes)[0];
    expect(route.requestKey).toBe(
      cacheabilityRequestIdentity(
        new Request("https://example.com/cached/intro", { headers: target.headers }),
      )?.requestKey,
    );
    expect(result.cacheableTargets).toEqual([target]);
  });

  it("omits dynamic identities from the deployed manifest and final warm targets", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-cacheability-probe-"));
    roots.push(root);
    fs.mkdirSync(path.join(root, "dist", "server"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "dist", "server", "vinext-server.json"),
      JSON.stringify({ prerenderSecret: "probe-secret" }),
    );
    const targets = [
      {
        headers: { Accept: "text/html" },
        kind: "html" as const,
        label: "/static",
        pathname: "/static",
        sourcePathname: "/static",
      },
      {
        headers: { Accept: "text/html" },
        kind: "html" as const,
        label: "/dynamic",
        pathname: "/dynamic",
        sourcePathname: "/dynamic",
      },
    ];
    const result = await probeStagedWorkerCacheability({
      buildId: "application-build",
      fetchImpl: async (input) => {
        const pathname = new URL(input instanceof Request ? input.url : String(input)).pathname;
        return Response.json({
          kind: "app-page",
          pattern: pathname,
          state: pathname === "/static" ? "static-candidate" : "dynamic",
          status: 200,
          version: 1,
        });
      },
      root,
      targetUrl: "https://example.com",
      targets,
    });

    expect(result.failures).toEqual([]);
    expect(result.cacheableTargets).toEqual([targets[0]]);
    expect(Object.values(result.manifest.routes)).toEqual([
      expect.objectContaining({ pattern: "/static", state: "static-candidate" }),
    ]);
  });
});
