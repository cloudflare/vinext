export const dynamic = "force-dynamic";

// Workers sends the bytes of DataView and ArrayBuffer stream chunks.
function streamBody(value: unknown, chunk: string | null): ReadableStream {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return new ReadableStream({
    start(controller) {
      controller.enqueue(
        chunk === "arraybuffer"
          ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
          : new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      );
      controller.close();
    },
  });
}

// Cached POSTs that differ only in the bytes of a stream body's chunks must
// not share a data cache entry.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const origin = new URL("/api/fetch-cache-stream-chunk-body/origin", request.url);
  const response = await fetch(origin, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: streamBody(
      { caseId: searchParams.get("case"), variant: searchParams.get("variant") },
      searchParams.get("chunk"),
    ),
    duplex: "half",
    next: { revalidate: 60 },
  } as RequestInit);
  return Response.json(await response.json());
}
