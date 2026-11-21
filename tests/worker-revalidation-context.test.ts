import { expect, it, vi } from "vite-plus/test";
import { createWorkerRevalidationContext } from "../packages/vinext/src/server/worker-revalidation-context.js";

it("preserves the host asset fetcher and middleware origin through ordinary and internal revalidation contexts", async () => {
  const assets = { fetch: vi.fn(() => new Response("host asset")) };
  const hostContext = { assets, middlewareOrigin: "http://localhost:3000", waitUntil() {} };
  const internalRequest = new Request("https://example.com/page");
  const dispatch = vi.fn<Parameters<typeof createWorkerRevalidationContext>[1]>(
    async (request, context) => {
      expect(request).toBe(internalRequest);
      expect(Reflect.get(context, "assets")).toBe(assets);
      expect(context.middlewareOrigin).toBe("http://localhost:3000");
      expect(context.isInternalPagesRevalidation).toBe(true);
      return new Response("revalidated");
    },
  );
  const context = createWorkerRevalidationContext(hostContext, dispatch);
  expect(Reflect.get(context, "assets")).toBe(assets);
  expect(context.middlewareOrigin).toBe("http://localhost:3000");
  expect(context.isInternalPagesRevalidation).toBe(false);
  const response = await context.dispatchPagesRevalidate!(internalRequest);
  expect(await response.text()).toBe("revalidated");
  expect(dispatch).toHaveBeenCalledOnce();
});
