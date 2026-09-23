import { expect, it, vi } from "vite-plus/test";
import { register } from "node:module";
import { registerPrerenderCloudflareLoader } from "../packages/vinext/src/build/prerender-cloudflare-loader.js";

vi.mock("node:module", () => ({ register: vi.fn() }));

it("rejects binding access and presence checks during prerender", async () => {
  registerPrerenderCloudflareLoader();
  const [[loaderUrl]] = vi.mocked(register).mock.calls;
  const loader = await import(/* @vite-ignore */ String(loaderUrl));
  const { url } = await loader.resolve("cloudflare:workers", {}, () => {
    throw new Error("native Worker import should be intercepted");
  });
  const { env } = await import(/* @vite-ignore */ url);

  expect(() => env.MY_KV).toThrow("Cloudflare bindings are unavailable");
  expect(() => "MY_KV" in env).toThrow("Cloudflare bindings are unavailable");
  expect(() => Object.keys(env)).toThrow("Cloudflare bindings are unavailable");
  expect(() => Object.hasOwn(env, "MY_KV")).toThrow("Cloudflare bindings are unavailable");
});
