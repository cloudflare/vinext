export const dynamic = "force-dynamic";

// Workers sends the bytes of ArrayBuffer and other typed array chunks.
function toChunk(
  bytes: Uint8Array<ArrayBuffer>,
  chunk: string | null,
): ArrayBuffer | ArrayBufferView {
  if (chunk === "arraybuffer") {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }
  if (chunk === "uint16array") {
    return new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
  }
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

// Workers sends the bytes a view's internal slots cover, whatever its own
// properties say, so these point the properties at other bytes.
function shadowByteRange(view: ArrayBuffer | ArrayBufferView): void {
  if (!ArrayBuffer.isView(view)) return;
  const decoy = new Uint8Array(view.byteLength);
  Object.defineProperties(view, {
    buffer: { value: decoy.buffer },
    byteOffset: { value: 0 },
    byteLength: { value: decoy.byteLength },
  });
}

function body(
  value: unknown,
  chunk: string | null,
  source: string | null,
  shadow: boolean,
): BodyInit {
  // Pad to an even length so the bytes fit a Uint16Array.
  let json = JSON.stringify(value);
  if (json.length % 2) json += " ";
  // Surround the body with bytes the chunk doesn't cover, which aren't sent.
  const encoded = new TextEncoder().encode(json);
  const buffer = new Uint8Array(encoded.byteLength + 4).fill(0x7b);
  buffer.set(encoded, 2);
  const bytes = toChunk(buffer.subarray(2, 2 + encoded.byteLength), chunk);
  if (shadow) shadowByteRange(bytes);
  if (source === "iterable") {
    return (async function* () {
      yield bytes;
    })() as unknown as BodyInit;
  }
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

// Cached POSTs that differ only in the bytes of their body's chunks must not
// share a data cache entry.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const origin = new URL("/api/fetch-cache-stream-chunk-body/origin", request.url);
  const response = await fetch(origin, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body(
      { caseId: searchParams.get("case"), variant: searchParams.get("variant") },
      searchParams.get("chunk"),
      searchParams.get("source"),
      searchParams.has("shadow"),
    ),
    duplex: "half",
    next: { revalidate: 60 },
  } as RequestInit);
  return Response.json(await response.json());
}
