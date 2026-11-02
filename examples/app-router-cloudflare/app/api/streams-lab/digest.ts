type DigestStreamInstance = WritableStream<ArrayBufferView | ArrayBuffer> & {
  readonly digest: Promise<ArrayBuffer>;
};

// The DOM lib's Crypto type shadows the Workers one, which has DigestStream.
const DigestStream = (
  crypto as unknown as { DigestStream: new (algorithm: string) => DigestStreamInstance }
).DigestStream;

/** Pipes a stream into crypto.DigestStream and returns its SHA-256 as hex. */
export async function sha256Hex(stream: ReadableStream<Uint8Array>): Promise<string> {
  const digest = new DigestStream("SHA-256");
  await stream.pipeTo(digest);
  return [...new Uint8Array(await digest.digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
