// Returns a fetched upstream Response unchanged. Node's fetch() decodes a
// compressed body but keeps the upstream Content-Length and Content-Encoding.
export async function GET(request: Request) {
  const searchParams = new URL(request.url).searchParams;
  const upstream = new URL("/payload", `http://127.0.0.1:${searchParams.get("port")}`);
  upstream.searchParams.set("key", searchParams.get("key") ?? "");
  return fetch(upstream, {
    cache: searchParams.get("cache") === "force-cache" ? "force-cache" : "no-store",
  });
}
