// App Router counterpart of pages/api/edge-blob-assets.ts: the same
// `fetch(new URL(<file>, import.meta.url))` pattern from an edge route handler,
// where fetch() also goes through vinext's patched fetch cache.
// Next.js: test/e2e/edge-compiler-can-import-blob-assets/index.test.ts
export const runtime = "edge";

const handlers = new Map<string, () => Promise<Response>>([
  ["text-file", () => fetch(new URL("../../../server-assets/text-file.txt", import.meta.url))],
  ["image-file", () => fetch(new URL("../../../server-assets/image.png", import.meta.url))],
  ["from-node-module", () => fetch(new URL("react/package.json", import.meta.url))],
]);

export async function GET(request: Request): Promise<Response> {
  const run = handlers.get(new URL(request.url).searchParams.get("handler") ?? "");
  return run ? run() : new Response("Invalid handler", { status: 400 });
}
