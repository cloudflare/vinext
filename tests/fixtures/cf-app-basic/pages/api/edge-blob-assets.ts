// Ported from Next.js: test/e2e/edge-compiler-can-import-blob-assets/app/pages/api/edge.js
// https://github.com/vercel/next.js/blob/canary/test/e2e/edge-compiler-can-import-blob-assets/app/pages/api/edge.js
//
// Workers have no filesystem, so these files must ship inside the Worker
// bundle (vinext:server-url-assets) for fetch() to load them.
export const config = {
  runtime: "edge",
};

type NextRequestLike = Request & { nextUrl: { searchParams: URLSearchParams } };

const handlers = new Map<string, () => Promise<Response>>([
  ["text-file", () => fetch(new URL("../../server-assets/text-file.txt", import.meta.url))],
  ["image-file", () => fetch(new URL("../../server-assets/image.png", import.meta.url))],
  // Not a sibling file, so it resolves as a module request (webpack parity).
  ["from-node-module", () => fetch(new URL("react/package.json", import.meta.url))],
  // Script files fetched as bytes are assets too, whatever the extension;
  // only code-loading contexts such as `new Worker(url)` keep a runtime URL.
  ["js-file", () => fetch(new URL("../../server-assets/payload.js", import.meta.url))],
  ["ts-file", () => fetch(new URL("../../server-assets/payload.ts", import.meta.url))],
]);

export default async function handler(req: NextRequestLike): Promise<Response> {
  const run = handlers.get(req.nextUrl.searchParams.get("handler") ?? "");
  return run ? run() : new Response("Invalid handler", { status: 400 });
}
