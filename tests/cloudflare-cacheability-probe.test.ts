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

  it("varies a hidden request key while retrying an older serving version", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-cacheability-probe-"));
    roots.push(root);
    fs.mkdirSync(path.join(root, "dist", "server"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "dist", "server", "vinext-server.json"),
      JSON.stringify({ prerenderSecret: "probe-secret" }),
    );

    const urls: URL[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      urls.push(url);
      const headers = new Headers(init?.headers);
      expect(headers.get(VINEXT_CACHEABILITY_PROBE_HEADER)).toBe("1");
      expect(headers.get(VINEXT_PRERENDER_SECRET_HEADER)).toBe("probe-secret");

      if (urls.length === 1) {
        return new Response("old serving Worker", { status: 404 });
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
      retries: 1,
      retryDelayMs: 0,
      root,
      targetUrl: "https://example.com",
      targets: [target],
    });

    expect(result.failures).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(urls.map((url) => url.pathname)).toEqual(["/cached/intro", "/cached/intro"]);
    const nonces = urls.map((url) => url.searchParams.get(VINEXT_CACHEABILITY_PROBE_QUERY_PARAM));
    expect(nonces[0]).toBeTruthy();
    expect(nonces[1]).toBeTruthy();
    expect(nonces[0]).not.toBe(nonces[1]);

    const route = Object.values(result.manifest.routes)[0];
    expect(route.requestKey).toBe(
      cacheabilityRequestIdentity(
        new Request("https://example.com/cached/intro", { headers: target.headers }),
      )?.requestKey,
    );
  });
});
