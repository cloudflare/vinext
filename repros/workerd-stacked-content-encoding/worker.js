const origin = "http://127.0.0.1:8788";

async function probe(path, manual = false) {
  const response = await fetch(`${origin}${path}`, {
    headers: { "accept-encoding": "gzip" },
    ...(manual ? { encodeResponseBody: "manual" } : {}),
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  const text = new TextDecoder().decode(bytes);

  let json;
  let jsonError;
  try {
    json = JSON.parse(text);
  } catch (error) {
    jsonError = error instanceof Error ? error.message : String(error);
  }

  return {
    contentEncoding: response.headers.get("content-encoding"),
    byteLength: bytes.byteLength,
    firstBytesHex: Array.from(bytes.slice(0, 8), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join(""),
    json: json ?? null,
    jsonError: jsonError ?? null,
  };
}

export default {
  async fetch() {
    const [singleDefault, stackedDefault, stackedManual] = await Promise.all([
      probe("/single"),
      probe("/stacked"),
      probe("/stacked", true),
    ]);

    return Response.json(
      {
        runtime: globalThis.navigator?.userAgent ?? "unknown",
        actual: { singleDefault, stackedDefault, stackedManual },
        expected: {
          singleDefault: "JSON succeeds",
          stackedDefault: "JSON succeeds after both gzip layers are decoded",
          stackedManual: "raw gzip bytes; JSON fails",
        },
      },
      { headers: { "cache-control": "no-store" } },
    );
  },
};
