import { describe, expect, it } from "vite-plus/test";
import { isAnimatedImage } from "../packages/vinext/src/server/image-animation.js";
import { ImageSourceReader } from "../packages/vinext/src/server/image-source-reader.js";
import {
  handleImageOptimization,
  markImageBuildAsset,
  sniffImageContentType,
} from "../packages/vinext/src/server/image-optimization.js";

// Ported from Next.js: packages/next/src/server/image-optimizer.ts
// https://github.com/vercel/next.js/blob/v16.2.6/packages/next/src/server/image-optimizer.ts
// `imageOptimizer` serves `BYPASS_TYPES` (SVG, ICO, ICNS, BMP, JPEG XL, HEIC)
// and animated GIF, PNG and WebP sources as-is, and rejects SVG unless
// `images.dangerouslyAllowSVG` is set.

const GIF_HEADER = [
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0x80, 0, 0, 0, 0, 0, 255, 255, 255,
];
const GIF_FRAME = [
  0x21, 0xf9, 4, 0, 10, 0, 0, 0, 0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 1, 0,
];
const STATIC_GIF = new Uint8Array([...GIF_HEADER, ...GIF_FRAME, 0x3b]);
const ANIMATED_GIF = new Uint8Array([...GIF_HEADER, ...GIF_FRAME, ...GIF_FRAME, 0x3b]);

function pngChunk(type: string, data: number[] = []): number[] {
  const length = data.length;
  return [
    (length >>> 24) & 0xff,
    (length >>> 16) & 0xff,
    (length >>> 8) & 0xff,
    length & 0xff,
    ...Array.from(type, (char) => char.charCodeAt(0)),
    ...data,
    0,
    0,
    0,
    0,
  ];
}
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const STATIC_PNG = new Uint8Array([
  ...PNG_SIGNATURE,
  ...pngChunk("IHDR", Array(13).fill(0)),
  ...pngChunk("IDAT", [0]),
  ...pngChunk("IEND"),
]);
const ANIMATED_PNG = new Uint8Array([
  ...PNG_SIGNATURE,
  ...pngChunk("IHDR", Array(13).fill(0)),
  ...pngChunk("acTL", Array(8).fill(0)),
  ...pngChunk("fcTL", Array(26).fill(0)),
  ...pngChunk("IDAT", [0]),
  ...pngChunk("fcTL", Array(26).fill(0)),
  ...pngChunk("fdAT", [0, 0, 0, 1, 0]),
  ...pngChunk("IEND"),
]);

function riff(chunks: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array([
    ...Array.from("RIFF", (char) => char.charCodeAt(0)),
    0,
    0,
    0,
    0,
    ...Array.from(`WEBP${chunks}`, (char) => char.charCodeAt(0)),
  ]);
}
const STATIC_WEBP = riff("VP8 \0\0\0\0");
const ANIMATED_WEBP = riff("VP8X\0\0\0\0ANIM\0\0\0\0");

/** `head` padded with zeros to `length` bytes. */
function padded(head: Uint8Array | number[], length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  bytes.set(head);
  return bytes;
}

/** A stream of `bytes` in chunks of `chunkSize`, counting the chunks pulled. */
function chunkedSource(bytes: Uint8Array, chunkSize: number) {
  const source = { pulled: 0, body: null as unknown as ReadableStream<Uint8Array> };
  let offset = 0;
  source.body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) return controller.close();
      source.pulled += 1;
      controller.enqueue(bytes.slice(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
  return source;
}

// A GIF frame whose image data runs to about 2 MiB, past what detection holds.
const LARGE_GIF_FRAME = [
  0x2c,
  ...Array(9).fill(0),
  2,
  ...Array.from({ length: 8_000 }, () => [255, ...Array(255).fill(1)]).flat(),
  0,
];

describe("isAnimatedImage", () => {
  const isAnimated = async (bytes: Uint8Array) => {
    // Parse byte by byte as well as whole, so no check depends on chunking.
    const whole = await isAnimatedImage(
      new ImageSourceReader(chunkedSource(bytes, Math.max(bytes.byteLength, 1)).body, Infinity),
    );
    const bytewise = await isAnimatedImage(
      new ImageSourceReader(chunkedSource(bytes, 1).body, Infinity),
    );
    expect(bytewise).toBe(whole);
    return whole;
  };

  it("detects animated GIF, PNG and WebP like Next.js' is-animated", async () => {
    expect(await isAnimated(ANIMATED_GIF)).toBe(true);
    expect(await isAnimated(ANIMATED_PNG)).toBe(true);
    expect(await isAnimated(ANIMATED_WEBP)).toBe(true);
    const largeGif = new Uint8Array([...GIF_HEADER, ...LARGE_GIF_FRAME, ...GIF_FRAME, 0x3b]);
    expect(
      await isAnimatedImage(new ImageSourceReader(chunkedSource(largeGif, 4_093).body, Infinity)),
    ).toBe(true);
  });

  it("treats single-frame images and other formats as still", async () => {
    expect(await isAnimated(STATIC_GIF)).toBe(false);
    expect(await isAnimated(STATIC_PNG)).toBe(false);
    expect(await isAnimated(STATIC_WEBP)).toBe(false);
    expect(await isAnimated(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe(false);
    expect(await isAnimated(new Uint8Array())).toBe(false);
  });

  it("finds a WebP ANIM chunk split across reads", async () => {
    const bytes = new Uint8Array(65_536 + 8);
    bytes.set(STATIC_WEBP);
    bytes.set([0x41, 0x4e, 0x49, 0x4d], 65_534);
    expect(await isAnimated(bytes)).toBe(true);
  });

  it("ends the scan at a truncated PNG chunk", async () => {
    expect(await isAnimated(ANIMATED_PNG.subarray(0, PNG_SIGNATURE.length + 30))).toBe(false);
  });
});

describe("handleImageOptimization formats Next.js does not optimize", () => {
  const imageRequest = (source: string) =>
    new Request(`http://localhost/_next/image?url=${encodeURIComponent(source)}&w=640&q=75`, {
      headers: { Accept: "image/avif,image/webp,*/*" },
    });

  function handlers(body: BodyInit, contentType: string) {
    const transformed: string[] = [];
    return {
      transformed,
      handlers: {
        fetchAsset: async () =>
          new Response(body, { status: 200, headers: { "Content-Type": contentType } }),
        transformImage: async (input: ReadableStream, options: { format: string }) => {
          transformed.push(new TextDecoder().decode(await new Response(input).arrayBuffer()));
          return new Response("transformed", { headers: { "Content-Type": options.format } });
        },
      },
    };
  }

  for (const [source, contentType, responseType] of [
    ["/favicon.ico", "image/x-icon", "image/x-icon"],
    ["/favicon.ico", "image/vnd.microsoft.icon", "image/x-icon"],
    ["/icon.icns", "image/x-icns", "image/x-icns"],
    ["/image.bmp", "image/bmp", "image/bmp"],
    ["/image.jxl", "image/jxl", "image/jxl"],
    ["/image.heic", "image/heic", "image/heic"],
  ] as const) {
    it(`serves ${contentType} as-is without transforming it`, async () => {
      const { handlers: imageHandlers, transformed } = handlers("source-bytes", contentType);
      const response = await handleImageOptimization(imageRequest(source), imageHandlers);
      expect(response.status).toBe(200);
      expect(transformed).toEqual([]);
      expect(await response.text()).toBe("source-bytes");
      expect(response.headers.get("Content-Type")).toBe(responseType);
      expect(response.headers.get("Cache-Control")).toBe("public, max-age=14400, must-revalidate");
      expect(response.headers.get("Vary")).toBe("Accept");
      expect(response.headers.get("Content-Security-Policy")).toBe(
        "script-src 'none'; frame-src 'none'; sandbox;",
      );
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(response.headers.get("x-nextjs-cache")).toBe("MISS");
    });
  }

  it("rejects SVG without dangerouslyAllowSVG and serves it as-is with it", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>';
    const blocked = handlers(svg, "image/svg+xml");
    const rejected = await handleImageOptimization(imageRequest("/logo.svg"), blocked.handlers);
    expect(rejected.status).toBe(400);
    expect(await rejected.text()).toBe('"url" parameter is valid but image type is not allowed');
    expect(rejected.headers.get("x-nextjs-cache")).toBeNull();

    const allowed = handlers(svg, "image/svg+xml");
    const response = await handleImageOptimization(
      imageRequest("/logo.svg"),
      allowed.handlers,
      undefined,
      { dangerouslyAllowSVG: true },
    );
    expect(response.status).toBe(200);
    expect(allowed.transformed).toEqual([]);
    expect(await response.text()).toBe(svg);
    expect(response.headers.get("Content-Type")).toBe("image/svg+xml");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=14400, must-revalidate");
    expect(response.headers.get("Content-Security-Policy")).toBe(
      "script-src 'none'; frame-src 'none'; sandbox;",
    );
  });

  it("keeps a build asset immutable, but not a public file under a _next/static folder", async () => {
    const { handlers: imageHandlers } = handlers("source-bytes", "image/x-icon");
    const buildAsset = await handleImageOptimization(
      imageRequest("/_next/static/media/favicon.0a1b2c3d.ico"),
      {
        ...imageHandlers,
        fetchAsset: async () => markImageBuildAsset(await imageHandlers.fetchAsset()),
      },
    );
    expect(buildAsset.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    const publicFile = await handleImageOptimization(
      imageRequest("/avatars/_next/static/favicon.ico"),
      imageHandlers,
    );
    expect(publicFile.headers.get("Cache-Control")).toBe("public, max-age=14400, must-revalidate");
  });

  for (const [name, bytes, contentType] of [
    ["GIF", ANIMATED_GIF, "image/gif"],
    ["PNG", ANIMATED_PNG, "image/png"],
    ["WebP", ANIMATED_WEBP, "image/webp"],
  ] as const) {
    it(`serves an animated ${name} as-is`, async () => {
      const { handlers: imageHandlers, transformed } = handlers(bytes, contentType);
      const response = await handleImageOptimization(imageRequest("/animated"), imageHandlers);
      expect(response.status).toBe(200);
      expect(transformed).toEqual([]);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
      expect(response.headers.get("Content-Type")).toBe(contentType);
      expect(response.headers.get("Cache-Control")).toBe("public, max-age=14400, must-revalidate");
    });
  }

  it("transforms a still GIF from its replayed bytes", async () => {
    const { handlers: imageHandlers, transformed } = handlers(STATIC_GIF, "image/gif");
    const response = await handleImageOptimization(imageRequest("/still.gif"), imageHandlers);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("transformed");
    expect(response.headers.get("Content-Type")).toBe("image/avif");
    expect(transformed).toEqual([new TextDecoder().decode(STATIC_GIF)]);
  });

  it("falls back to the replayed source when the transform fails", async () => {
    const response = await handleImageOptimization(imageRequest("/still.png"), {
      fetchAsset: async () =>
        new Response(STATIC_PNG, { status: 200, headers: { "Content-Type": "image/png" } }),
      transformImage: async (input: ReadableStream) => {
        await new Response(input).arrayBuffer();
        throw new Error("unsupported");
      },
    });
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(STATIC_PNG);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=14400, must-revalidate");
  });
});

describe("handleImageOptimization passthrough Cache-Control", () => {
  const imageRequest = (source: string) =>
    new Request(`http://localhost/_next/image?url=${encodeURIComponent(source)}&w=640&q=75`);
  const source = (contentType: string, cacheControl: string, body: BodyInit = "source") => ({
    fetchAsset: async () =>
      new Response(body, {
        status: 200,
        headers: { "Content-Type": contentType, "Cache-Control": cacheControl },
      }),
  });

  // Next.js sends max(images.minimumCacheTTL, the source's s-maxage or max-age).
  it("keeps a source max-age longer than the minimum TTL", async () => {
    for (const [cacheControl, expected] of [
      ["public, max-age=86400", "public, max-age=86400, must-revalidate"],
      ["public, max-age=60, s-maxage=90000", "public, max-age=90000, must-revalidate"],
      ['public, max-age="172800"', "public, max-age=172800, must-revalidate"],
      ["public, max-age=0, must-revalidate", "public, max-age=14400, must-revalidate"],
    ] as const) {
      const bypass = await handleImageOptimization(
        imageRequest("/favicon.ico"),
        source("image/x-icon", cacheControl),
      );
      expect(bypass.headers.get("Cache-Control"), cacheControl).toBe(expected);
      const unoptimized = await handleImageOptimization(
        imageRequest("/image.jpg"),
        source("image/jpeg", cacheControl),
      );
      expect(unoptimized.headers.get("Cache-Control"), cacheControl).toBe(expected);
    }
  });

  it("keeps an animated source's max-age", async () => {
    const response = await handleImageOptimization(imageRequest("/animated.gif"), {
      ...source("image/gif", "public, max-age=86400", ANIMATED_GIF),
      transformImage: async () => new Response("transformed"),
    });
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=86400, must-revalidate");
  });

  it("uses images.minimumCacheTTL as the least max-age", async () => {
    for (const [cacheControl, expected] of [
      ["public, max-age=0", "public, max-age=60, must-revalidate"],
      ["public, max-age=86400", "public, max-age=86400, must-revalidate"],
    ] as const) {
      const response = await handleImageOptimization(
        imageRequest("/favicon.ico"),
        source("image/x-icon", cacheControl),
        undefined,
        { minimumCacheTTL: 60 },
      );
      expect(response.headers.get("Cache-Control"), cacheControl).toBe(expected);
    }
  });

  it("uses only the minimum TTL after a failed transform", async () => {
    const response = await handleImageOptimization(imageRequest("/image.jpg"), {
      ...source("image/jpeg", "public, max-age=86400"),
      transformImage: async () => {
        throw new Error("unsupported");
      },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=14400, must-revalidate");
  });
});

describe("handleImageOptimization source size limit", () => {
  // Next.js reads at most `images.maximumResponseBody` (50 MB by default) of a
  // source and answers 413 past it.
  const TOO_LARGE = '"url" parameter is valid but internal response is invalid';
  const transformImage = async () => new Response("transformed");
  const imageRequest = new Request("http://localhost/_next/image?url=%2Fbig.png&w=640&q=75");

  it("answers 413 for a source that declares more than the limit once it reads past it", async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(STATIC_PNG);
      },
    });
    const response = await handleImageOptimization(
      imageRequest,
      {
        fetchAsset: async () =>
          new Response(body, {
            status: 200,
            headers: { "Content-Type": "image/png", "Content-Length": "1001" },
          }),
        // Reads its whole input before it resolves, as Cloudflare Images does.
        transformImage: async (input) => {
          await new Response(input).arrayBuffer();
          return new Response("transformed");
        },
      },
      undefined,
      { maximumResponseBody: 1_000 },
    );
    expect(response.status).toBe(413);
    expect(await response.text()).toBe(TOO_LARGE);
    // Like Next.js, the bytes read count, not the length declared, and reading
    // stops once they pass the limit.
    const chunksPastLimit = Math.ceil(1_000 / STATIC_PNG.byteLength) + 1;
    expect(pulled).toBeGreaterThanOrEqual(chunksPastLimit);
    expect(pulled).toBeLessThanOrEqual(chunksPastLimit + 2);
  });

  it("passes the whole source to the optimizer whatever its chunking and Content-Length", async () => {
    const bytes = new Uint8Array(100_000).map((_, i) => i % 251);
    bytes.set(STATIC_PNG);
    for (const contentLength of [null, "10", String(bytes.byteLength), "200000"]) {
      let received: Uint8Array | null = null;
      const response = await handleImageOptimization(imageRequest, {
        fetchAsset: async () => {
          let offset = 0;
          const body = new ReadableStream<Uint8Array>({
            pull(controller) {
              if (offset >= bytes.byteLength) return controller.close();
              controller.enqueue(bytes.slice(offset, offset + 7_000));
              offset += 7_000;
            },
          });
          const headers = new Headers({ "Content-Type": "image/png" });
          if (contentLength !== null) headers.set("Content-Length", contentLength);
          return new Response(body, { status: 200, headers });
        },
        transformImage: async (body) => {
          received = new Uint8Array(await new Response(body).arrayBuffer());
          return new Response("transformed", { headers: { "Content-Type": "image/webp" } });
        },
      });
      expect(response.status, String(contentLength)).toBe(200);
      expect(received, String(contentLength)).toEqual(bytes);
    }
  });

  // An APNG's detection reads it to the end; a source still streaming keeps
  // the length it declared, as a format served as-is does.
  it("sends a source read whole at the length read, not the one declared", async () => {
    for (const [bytes, transform] of [
      [ANIMATED_PNG, transformImage],
      [
        STATIC_PNG,
        async (input: ReadableStream) => {
          await new Response(input).arrayBuffer();
          throw new Error("unsupported");
        },
      ],
    ] as const) {
      for (const contentLength of ["3", "999"]) {
        const response = await handleImageOptimization(imageRequest, {
          fetchAsset: async () =>
            new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(bytes);
                  controller.close();
                },
              }),
              {
                status: 200,
                headers: { "Content-Type": "image/png", "Content-Length": contentLength },
              },
            ),
          transformImage: transform,
        });
        expect(response.status).toBe(200);
        expect(response.headers.get("Content-Length")).toBe(String(bytes.byteLength));
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
      }
    }
  });

  it("answers 413 when cancelling the source fails or never settles", async () => {
    for (const cancel of [
      () => Promise.reject(new Error("cancel failed")),
      () => new Promise<void>(() => {}),
    ]) {
      for (const declared of ["11", null]) {
        const response = await handleImageOptimization(
          imageRequest,
          {
            fetchAsset: async () => {
              const body = new ReadableStream<Uint8Array>({
                pull(controller) {
                  controller.enqueue(new Uint8Array(6));
                },
                cancel,
              });
              const headers = new Headers({ "Content-Type": "image/png" });
              if (declared !== null) headers.set("Content-Length", declared);
              return new Response(body, { status: 200, headers });
            },
            transformImage,
          },
          undefined,
          { maximumResponseBody: 10 },
        );
        expect(response.status).toBe(413);
        expect(await response.text()).toBe(TOO_LARGE);
      }
    }
  });

  it("uses images.maximumResponseBody as the limit", async () => {
    const response = await handleImageOptimization(
      imageRequest,
      {
        fetchAsset: async () =>
          new Response(new Uint8Array(11), {
            status: 200,
            headers: { "Content-Type": "image/png" },
          }),
        transformImage,
      },
      undefined,
      { maximumResponseBody: 10 },
    );
    expect(response.status).toBe(413);
    expect(await response.text()).toBe(TOO_LARGE);
  });

  it("stops reading a source streamed to the optimizer once it exceeds the limit", async () => {
    const chunk = new Uint8Array(1_000_000);
    let enqueued = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        enqueued += 1;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = await handleImageOptimization(imageRequest, {
      fetchAsset: async () =>
        new Response(body, { status: 200, headers: { "Content-Type": "image/png" } }),
      transformImage: async (input) => {
        await new Response(input).arrayBuffer();
        return new Response("transformed");
      },
    });
    expect(response.status).toBe(413);
    expect(await response.text()).toBe(TOO_LARGE);
    expect(cancelled).toBe(true);
    expect(enqueued).toBeLessThanOrEqual(52);
  });
});

describe("handleImageOptimization source size limit for every type", () => {
  // Next.js reads a whole source, answering 413 past images.maximumResponseBody,
  // before it types it, whatever the type turns out to be.
  const TOO_LARGE = '"url" parameter is valid but internal response is invalid';
  const LIMIT = 100;
  const imageRequest = new Request("http://localhost/_next/image?url=%2Fsource&w=640&q=75", {
    headers: { Accept: "image/webp" },
  });
  const text = (value: string) => new TextEncoder().encode(value);
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8">';
  const avifBox = [0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66];
  const cases = [
    { name: "SVG", head: text(svg), label: "image/svg+xml", allowSvg: true },
    { name: "SVG without dangerouslyAllowSVG", head: text(svg), label: "image/svg+xml" },
    { name: "SVG labelled PNG", head: text(svg), label: "image/png", allowSvg: true },
    { name: "HTML labelled PNG", head: text("<!DOCTYPE html>"), label: "image/png" },
    { name: "ICO", head: [0, 0, 1, 0], label: "image/x-icon" },
    { name: "JPEG", head: [0xff, 0xd8, 0xff], label: "image/jpeg" },
    { name: "AVIF", head: avifBox, label: "application/octet-stream" },
    { name: "PNG without an optimizer", head: STATIC_PNG, label: "image/png", optimizer: false },
    { name: "animated GIF", head: ANIMATED_GIF, label: "image/gif" },
  ];

  // A declared length comes in one chunk; an undeclared one in chunks. A source
  // can also declare less than it is.
  type Delivery = { chunkSize: number | null; declares?: number };
  const deliveries: Record<string, Delivery> = {
    declared: { chunkSize: null },
    "in 10-byte chunks": { chunkSize: 10 },
    [`in ${3 * LIMIT}-byte chunks`]: { chunkSize: 3 * LIMIT },
    "declaring less than it is": { chunkSize: 10, declares: LIMIT / 5 },
  };

  function handlers(bytes: Uint8Array, label: string, delivery: Delivery, optimizer = true) {
    const transformed: number[] = [];
    const { chunkSize, declares = chunkSize === null ? bytes.byteLength : undefined } = delivery;
    return {
      transformed,
      fetchAsset: async () => {
        const headers = new Headers({ "Content-Type": label });
        if (declares !== undefined) headers.set("Content-Length", String(declares));
        return new Response(chunkedSource(bytes, chunkSize ?? bytes.byteLength).body, {
          headers,
        });
      },
      transformImage: optimizer
        ? async (input: ReadableStream<Uint8Array>) => {
            // Count the bytes as they are read, including before a read fails.
            const reader = input.getReader();
            let read = 0;
            try {
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                read += value.byteLength;
              }
            } finally {
              transformed.push(read);
            }
            return new Response("transformed", { headers: { "Content-Type": "image/webp" } });
          }
        : undefined,
    };
  }

  for (const { name, head, label, allowSvg = false, optimizer = true } of cases) {
    for (const [delivery, options] of Object.entries(deliveries)) {
      it(`answers 413 for a ${name} source past the limit, ${delivery}`, async () => {
        const { transformed, ...sourceHandlers } = handlers(
          padded(head, 3 * LIMIT),
          label,
          options,
          optimizer,
        );
        const response = await handleImageOptimization(imageRequest, sourceHandlers, undefined, {
          maximumResponseBody: LIMIT,
          dangerouslyAllowSVG: allowSvg,
        });
        expect(response.status).toBe(413);
        expect(await response.text()).toBe(TOO_LARGE);
        // The optimizer never reads past the limit.
        expect(transformed.every((length) => length <= LIMIT)).toBe(true);
      });
    }

    it(`does not answer 413 for a ${name} source at the limit`, async () => {
      // Including one that declares more than it is, as only bytes read count.
      const atLimit: Delivery[] = [
        { chunkSize: null },
        { chunkSize: 10 },
        { chunkSize: 10, declares: LIMIT + 1 },
      ];
      for (const delivery of atLimit) {
        const response = await handleImageOptimization(
          imageRequest,
          handlers(padded(head, LIMIT), label, delivery, optimizer),
          undefined,
          { maximumResponseBody: LIMIT, dangerouslyAllowSVG: allowSvg },
        );
        expect(response.status, JSON.stringify(delivery)).not.toBe(413);
        await response.arrayBuffer();
      }
    });
  }
});

describe("handleImageOptimization fallback after the optimizer rejects early", () => {
  const imageRequest = new Request("http://localhost/_next/image?url=%2Fbig.png&w=640&q=75");
  const bytes = new Uint8Array(158);
  bytes.set(STATIC_PNG);
  const rejectUnread = async () => Promise.reject(new Error("unsupported"));

  function source(contentLength: string | null) {
    const fetched = { cancelled: [] as boolean[] };
    return {
      fetched,
      fetchAsset: async () => {
        const index = fetched.cancelled.push(false) - 1;
        let offset = 0;
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (offset >= bytes.byteLength) return controller.close();
            controller.enqueue(bytes.slice(offset, offset + 64));
            offset += 64;
          },
          cancel() {
            fetched.cancelled[index] = true;
          },
        });
        const headers = new Headers({ "Content-Type": "image/png" });
        if (contentLength !== null) headers.set("Content-Length", contentLength);
        return new Response(body, { status: 200, headers });
      },
    };
  }

  it("cancels the source detection read before fetching it again", async () => {
    const { fetched, fetchAsset } = source(null);
    const response = await handleImageOptimization(imageRequest, {
      fetchAsset,
      transformImage: rejectUnread,
    });
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(fetched.cancelled).toEqual([true, false]);
  });

  it("fetches a source again once the optimizer has read some of it", async () => {
    const jpeg = padded([0xff, 0xd8, 0xff], 40);
    let fetches = 0;
    const response = await handleImageOptimization(imageRequest, {
      fetchAsset: async () => {
        fetches += 1;
        return new Response(chunkedSource(jpeg, 8).body, {
          headers: { "Content-Type": "image/jpeg", "Content-Length": "40" },
        });
      },
      // Like an optimizer that fails partway through, then lets the body go.
      transformImage: async (input) => {
        const reader = input.getReader();
        await reader.read();
        reader.releaseLock();
        throw new Error("corrupt");
      },
    });
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(jpeg);
    expect(fetches).toBe(2);
  });

  it("answers 413 for a source past the limit the optimizer rejects unread", async () => {
    const jpeg = padded([0xff, 0xd8, 0xff], 300);
    const response = await handleImageOptimization(
      imageRequest,
      {
        fetchAsset: async () =>
          new Response(chunkedSource(jpeg, 10).body, { headers: { "Content-Type": "image/jpeg" } }),
        transformImage: rejectUnread,
      },
      undefined,
      { maximumResponseBody: 100 },
    );
    expect(response.status).toBe(413);
  });

  it("fetches a source again once the optimizer has cancelled it", async () => {
    const jpeg = padded([0xff, 0xd8, 0xff], 40);
    let fetches = 0;
    const response = await handleImageOptimization(imageRequest, {
      fetchAsset: async () => {
        fetches += 1;
        return new Response(chunkedSource(jpeg, 8).body, {
          headers: { "Content-Type": "image/jpeg", "Content-Length": "40" },
        });
      },
      transformImage: async (input) => {
        await input.cancel();
        throw new Error("unsupported");
      },
    });
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(jpeg);
    expect(fetches).toBe(2);
  });

  it("cancels a source the optimizer let go of before fetching it again", async () => {
    const jpeg = padded([0xff, 0xd8, 0xff], 40);
    const cancelled: boolean[] = [];
    const response = await handleImageOptimization(imageRequest, {
      fetchAsset: async () => {
        const index = cancelled.push(false) - 1;
        const source = chunkedSource(jpeg, 8).body;
        const reader = source.getReader();
        const body = new ReadableStream<Uint8Array>({
          pull: async (controller) => {
            const { done, value } = await reader.read();
            if (done) controller.close();
            else controller.enqueue(value);
          },
          cancel: (reason) => {
            cancelled[index] = true;
            return reader.cancel(reason);
          },
        });
        return new Response(body, { headers: { "Content-Type": "image/jpeg" } });
      },
      transformImage: async (input) => {
        const reader = input.getReader();
        await reader.read();
        reader.releaseLock();
        throw new Error("unsupported");
      },
    });
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(jpeg);
    expect(cancelled[0]).toBe(true);
  });

  it("labels a source fetched again by its own type", async () => {
    // Bytes of no known type keep their ICO label. Past what is held to
    // replay, the source is fetched again, as a JPEG by then.
    const ico = new Uint8Array(1_200_000);
    const jpeg = padded([0xff, 0xd8, 0xff], 1_200_000);
    let fetches = 0;
    const response = await handleImageOptimization(imageRequest, {
      fetchAsset: async () => {
        fetches += 1;
        const bytes = fetches === 1 ? ico : jpeg;
        return new Response(chunkedSource(bytes, 64 * 1024).body, {
          headers: { "Content-Type": "image/vnd.microsoft.icon" },
        });
      },
    });
    expect(fetches).toBe(2);
    expect(response.headers.get("Content-Type")).toBe("image/jpeg");
    await response.arrayBuffer();
  });

  it("reads a source fetched again once the optimizer cancelled a read still pending", async () => {
    const LIMIT = 100;
    // JPEG reaches the optimizer as it streams in; PNG through its animation check.
    const sources: [string, Uint8Array | number[]][] = [
      ["image/jpeg", [0xff, 0xd8, 0xff]],
      ["image/png", STATIC_PNG],
    ];
    for (const [label, head] of sources) {
      const bytes = padded(head, 3 * LIMIT);
      let fetches = 0;
      const response = await handleImageOptimization(
        imageRequest,
        {
          fetchAsset: async () => {
            fetches += 1;
            // The first fetch stalls after its first chunk; the second runs past the limit.
            const body =
              fetches === 1
                ? new ReadableStream<Uint8Array>({
                    start: (controller) => controller.enqueue(bytes.slice(0, 60)),
                  })
                : chunkedSource(bytes, 10).body;
            return new Response(body, { headers: { "Content-Type": label } });
          },
          transformImage: async (input) => {
            const reader = input.getReader();
            await reader.read();
            // Cancel once the next read waits on the stalled source.
            const pending = reader.read();
            await new Promise((resolve) => setTimeout(resolve, 0));
            await reader.cancel();
            await pending;
            throw new Error("unsupported");
          },
        },
        undefined,
        { maximumResponseBody: LIMIT },
      );
      expect(response.status, label).toBe(413);
      expect(fetches, label).toBe(2);
    }
  });

  it("streams a source fetched again once the optimizer read it whole within the limit", async () => {
    // Past what is held to replay, and declaring no length, as Workers assets do.
    const jpeg = padded([0xff, 0xd8, 0xff], 1_200_000);
    let fetches = 0;
    const response = await handleImageOptimization(imageRequest, {
      fetchAsset: async () => {
        fetches += 1;
        return new Response(chunkedSource(jpeg, 64 * 1024).body, {
          headers: { "Content-Type": "image/jpeg" },
        });
      },
      transformImage: async (input) => {
        await new Response(input).arrayBuffer();
        throw new Error("corrupt");
      },
    });
    expect(response.status).toBe(200);
    // Compared whole, as a deep equality of each byte is slow at this size.
    expect(Buffer.from(await response.arrayBuffer()).equals(jpeg)).toBe(true);
    expect(fetches).toBe(2);
  });

  it("keeps the source fetched again within images.maximumResponseBody", async () => {
    // The first fetch declares no length, so detection reads within the limit.
    let fetches = 0;
    const declared = source("158");
    const undeclared = source(null);
    const response = await handleImageOptimization(
      imageRequest,
      {
        fetchAsset: () => (fetches++ === 0 ? undeclared : declared).fetchAsset(),
        transformImage: rejectUnread,
      },
      undefined,
      { maximumResponseBody: 80 },
    );
    expect(response.status).toBe(413);

    const streamed = await handleImageOptimization(
      imageRequest,
      { fetchAsset: source(null).fetchAsset, transformImage: rejectUnread },
      undefined,
      { maximumResponseBody: 80 },
    );
    expect(streamed.status).toBe(413);
  });
});

describe("handleImageOptimization animation detection memory", () => {
  // Deep equality is slow on megabytes; compare them natively.
  const sameBytes = (actual: Uint8Array | null, expected: Uint8Array) =>
    actual !== null && Buffer.from(actual).equals(Buffer.from(expected));
  const imageRequest = new Request("http://localhost/_next/image?url=%2Fbig&w=640&q=75");

  it("streams a still PNG to the optimizer without reading it ahead", async () => {
    const bytes = new Uint8Array(5_000_000);
    bytes.set(STATIC_PNG);
    const source = chunkedSource(bytes, 65_536);
    let pulledAtTransform = -1;
    let received: Uint8Array | null = null;
    let fetches = 0;
    const response = await handleImageOptimization(imageRequest, {
      fetchAsset: async () => {
        fetches += 1;
        return new Response(source.body, { status: 200, headers: { "Content-Type": "image/png" } });
      },
      transformImage: async (input) => {
        pulledAtTransform = source.pulled;
        received = new Uint8Array(await new Response(input).arrayBuffer());
        return new Response("transformed", { headers: { "Content-Type": "image/webp" } });
      },
    });
    expect(response.status).toBe(200);
    expect(pulledAtTransform).toBeLessThanOrEqual(2);
    expect(sameBytes(received, bytes)).toBe(true);
    expect(fetches).toBe(1);
  });

  it("fetches a source again once detection has read more than it holds", async () => {
    const stillWebp = new Uint8Array(3_000_000);
    stillWebp.set(STATIC_WEBP);
    const animatedGif = new Uint8Array([...GIF_HEADER, ...LARGE_GIF_FRAME, ...GIF_FRAME, 0x3b]);
    for (const [bytes, contentType, animated] of [
      [stillWebp, "image/webp", false],
      [animatedGif, "image/gif", true],
    ] as const) {
      let fetches = 0;
      let received: Uint8Array | null = null;
      const response = await handleImageOptimization(imageRequest, {
        fetchAsset: async () => {
          fetches += 1;
          return new Response(chunkedSource(bytes, 65_536).body, {
            status: 200,
            headers: { "Content-Type": contentType },
          });
        },
        transformImage: async (input) => {
          received = new Uint8Array(await new Response(input).arrayBuffer());
          return new Response("transformed", { headers: { "Content-Type": "image/webp" } });
        },
      });
      expect(response.status, contentType).toBe(200);
      expect(fetches, contentType).toBe(2);
      if (animated) {
        expect(received, contentType).toBeNull();
        expect(sameBytes(new Uint8Array(await response.arrayBuffer()), bytes)).toBe(true);
      } else {
        expect(sameBytes(received, bytes), contentType).toBe(true);
      }
    }
  });
});

describe("handleImageOptimization source without an image Content-Type", () => {
  const ICNS = new Uint8Array([0x69, 0x63, 0x6e, 0x73, 0, 0, 0, 8]);
  const imageRequest = (source: string) =>
    new Request(`http://localhost/_next/image?url=${encodeURIComponent(source)}&w=640&q=75`);
  // Split the bytes so the signature spans chunks.
  const chunked = (bytes: Uint8Array) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 2));
        controller.enqueue(bytes.slice(2));
        controller.close();
      },
    });

  it("detects types by Next.js's signatures", () => {
    const bytes = (...values: number[]) => new Uint8Array(values);
    expect(sniffImageContentType(ICNS)).toBe("image/x-icns");
    expect(sniffImageContentType(bytes(0, 0, 1, 0))).toBe("image/x-icon");
    expect(sniffImageContentType(bytes(0x42, 0x4d))).toBe("image/bmp");
    expect(sniffImageContentType(bytes(0xff, 0x0a))).toBe("image/jxl");
    // An ISOBMFF `ftyp` box is HEIC only when the bytes hold its whole size.
    const heic = [0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63];
    expect(sniffImageContentType(bytes(...heic, ...Array(12).fill(0)))).toBe("image/heic");
    expect(sniffImageContentType(bytes(...heic))).toBeNull();
    expect(sniffImageContentType(new TextEncoder().encode("<svg xmlns"))).toBe("image/svg+xml");
    expect(sniffImageContentType(new TextEncoder().encode("<!DOCTYPE html>"))).toBeNull();
    expect(sniffImageContentType(new Uint8Array())).toBeNull();
  });

  for (const contentType of [null, "application/octet-stream"]) {
    it(`serves an ICNS source typed ${contentType} as-is`, async () => {
      const response = await handleImageOptimization(imageRequest("/icon.icns"), {
        fetchAsset: async () => {
          const response = new Response(chunked(ICNS), { status: 200 });
          if (contentType === null) response.headers.delete("Content-Type");
          else response.headers.set("Content-Type", contentType);
          return response;
        },
        transformImage: async () => new Response("transformed"),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("image/x-icns");
      expect(response.headers.get("Cache-Control")).toBe("public, max-age=14400, must-revalidate");
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(ICNS);
    });
  }

  it("replays a large first chunk unchanged", async () => {
    const bytes = new Uint8Array(1_000_000);
    bytes.set(ICNS);
    const response = await handleImageOptimization(imageRequest("/icon.icns"), {
      fetchAsset: async () => new Response(bytes, { status: 200 }),
    });
    expect(response.headers.get("Content-Type")).toBe("image/x-icns");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

  it("still rejects a source whose bytes are not an allowed image", async () => {
    for (const [body, message] of [
      ["<!DOCTYPE html><p>page</p>", "The requested resource isn't a valid image."],
      ["<svg onload=alert(1)></svg>", '"url" parameter is valid but image type is not allowed'],
    ]) {
      const response = await handleImageOptimization(imageRequest("/page"), {
        fetchAsset: async () =>
          new Response(body, { status: 200, headers: { "Content-Type": "text/html" } }),
      });
      expect(response.status, body).toBe(400);
      expect(await response.text(), body).toBe(message);
    }
  });
});

// Next.js types a source by its bytes, whatever its name or Content-Type
// (detectContentType in
// packages/next/src/server/image-optimizer/detect-content-type.ts), so an SVG
// is an SVG under any label. Observed with `next start` on next@16.4.5.
describe("handleImageOptimization source typed by its bytes", () => {
  const SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64"/></svg>';
  const NOT_ALLOWED = '"url" parameter is valid but image type is not allowed';
  const imageRequest = new Request("http://localhost/_next/image?url=%2Fimage&w=640&q=75", {
    headers: { Accept: "image/webp" },
  });

  function source(body: BodyInit, contentType: string | null) {
    const transformed: string[] = [];
    return {
      transformed,
      fetchAsset: async () => {
        const response = new Response(body, { status: 200 });
        if (contentType === null) response.headers.delete("Content-Type");
        else response.headers.set("Content-Type", contentType);
        return response;
      },
      transformImage: async (input: ReadableStream, options: { format: string }) => {
        transformed.push(new TextDecoder().decode(await new Response(input).arrayBuffer()));
        return new Response("transformed", { headers: { "Content-Type": options.format } });
      },
    };
  }

  it("finds an SVG root element as Next.js' detector does", async () => {
    const svgRoot = /<svg\s([^>"']|"[^"]*"|'[^']*')*>/;
    for (const text of [
      '<!-- c --><svg width="1">',
      "<!-- c --><svg\n>",
      "<!-- c --><svg a=\">\" b='>'>",
      '<!-- c --><svg a=">"',
      '<!-- c --><svg a="unclosed <svg b>',
      "<!-- c --><svgx a>",
      "<!-- c --><svg>",
      "<!-- c --><svg ",
    ]) {
      const { fetchAsset } = source(text, "image/png");
      const response = await handleImageOptimization(imageRequest, { fetchAsset }, undefined, {
        dangerouslyAllowSVG: true,
      });
      expect(response.status === 200, text).toBe(svgRoot.test(text));
    }
  });

  it("does not take text with `ftyp` at offset 4 for an ISOBMFF image", () => {
    const encode = (text: string) => new TextEncoder().encode(text);
    expect(sniffImageContentType(encode(`<!--ftypavif-->${SVG}`))).toBeNull();
    expect(sniffImageContentType(encode(`<!--ftypheic-->${SVG}`))).toBeNull();
    const avif = [0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66];
    expect(sniffImageContentType(new Uint8Array([...avif, ...Array(16).fill(0)]))).toBe(
      "image/avif",
    );
  });

  for (const [body, contentType] of [
    [SVG, "image/png"],
    [`<!--ftypavif-->${SVG}`, "image/avif"],
    [`<!--ftypavif-->${SVG}`, "application/octet-stream"],
    [`<!--ftypavif-->${SVG}`, null],
    [`<!-- logo -->${SVG}`, "image/png"],
    [`﻿\n  ${SVG}`, "image/webp"],
  ] as const) {
    for (const optimizer of [true, false]) {
      it(`rejects ${JSON.stringify(body.slice(0, 16))} typed ${contentType} ${optimizer ? "before the optimizer" : "without an optimizer"}`, async () => {
        const { transformed, fetchAsset, transformImage } = source(body, contentType);
        const response = await handleImageOptimization(
          imageRequest,
          optimizer ? { fetchAsset, transformImage } : { fetchAsset },
        );
        expect(response.status).toBe(400);
        expect(await response.text()).toBe(NOT_ALLOWED);
        expect(transformed).toEqual([]);
      });
    }

    it(`serves ${JSON.stringify(body.slice(0, 16))} typed ${contentType} as SVG with dangerouslyAllowSVG`, async () => {
      const { transformed, fetchAsset, transformImage } = source(body, contentType);
      const response = await handleImageOptimization(
        imageRequest,
        { fetchAsset, transformImage },
        undefined,
        { dangerouslyAllowSVG: true },
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("image/svg+xml");
      // Compare bytes: text() would drop a byte order mark.
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(new TextEncoder().encode(body));
      expect(transformed).toEqual([]);
    });
  }

  it("rejects markup typed as an image even with dangerouslyAllowSVG", async () => {
    const utf16Svg = new Uint8Array([
      0xff,
      0xfe,
      ...Array.from(SVG, (char) => [char.charCodeAt(0), 0]).flat(),
    ]);
    for (const body of ["<!DOCTYPE html><p>page</p>", utf16Svg]) {
      const { transformed, fetchAsset, transformImage } = source(body, "image/png");
      const response = await handleImageOptimization(
        imageRequest,
        { fetchAsset, transformImage },
        undefined,
        { dangerouslyAllowSVG: true },
      );
      expect(response.status).toBe(400);
      expect(await response.text()).toBe("The requested resource isn't a valid image.");
      expect(transformed).toEqual([]);
    }
  });

  it("reads a whole ftyp box past the first 1000 bytes to type the source", async () => {
    const box = new Uint8Array(2_000);
    box.set([0, 0, 0x07, 0xd0, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66]);
    for (const [bytes, status] of [
      [box, 200],
      [box.subarray(0, 1_500), 400],
    ] as const) {
      const transformed: number[] = [];
      const response = await handleImageOptimization(imageRequest, {
        fetchAsset: async () =>
          new Response(chunkedSource(bytes, 100).body, {
            headers: { "Content-Type": "application/octet-stream" },
          }),
        transformImage: async (input, options) => {
          transformed.push((await new Response(input).arrayBuffer()).byteLength);
          return new Response("transformed", { headers: { "Content-Type": options.format } });
        },
      });
      expect(response.status).toBe(status);
      expect(transformed).toEqual(status === 200 ? [bytes.byteLength] : []);
    }
  });

  it("holds only the bytes detection reads of an ftyp box, fetching the source again", async () => {
    const box = new Uint8Array(20_000);
    box.set([0, 0, 0x4e, 0x20, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66]);
    let fetches = 0;
    let cancelled = 0;
    const transformed: number[] = [];
    const response = await handleImageOptimization(imageRequest, {
      fetchAsset: async () => {
        fetches++;
        const chunks = chunkedSource(box, 100).body.getReader();
        return new Response(
          new ReadableStream<Uint8Array>({
            async pull(controller) {
              const { done, value } = await chunks.read();
              if (done) controller.close();
              else controller.enqueue(value);
            },
            cancel() {
              cancelled++;
            },
          }),
          { headers: { "Content-Type": "application/octet-stream" } },
        );
      },
      transformImage: async (input, options) => {
        transformed.push((await new Response(input).arrayBuffer()).byteLength);
        return new Response("transformed", { headers: { "Content-Type": options.format } });
      },
    });
    expect(response.status).toBe(200);
    expect(fetches).toBe(2);
    expect(cancelled).toBe(1);
    expect(transformed).toEqual([box.byteLength]);
  });

  it("types a source fetched again afresh when its first bytes changed", async () => {
    const box = new Uint8Array(20_000);
    box.set([0, 0, 0x4e, 0x20, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66]);
    const otherBox = box.slice();
    otherBox[20] = 1;
    for (const [second, status, body] of [
      [new TextEncoder().encode(SVG), 400, NOT_ALLOWED],
      [otherBox, 400, "The requested resource isn't a valid image."],
      // Ending before the box, so not AVIF by its own bytes.
      [box.subarray(0, 1_000), 400, NOT_ALLOWED],
      [box, 200, "transformed"],
    ] as const) {
      let fetches = 0;
      const response = await handleImageOptimization(imageRequest, {
        fetchAsset: async () =>
          new Response(chunkedSource(fetches++ === 0 ? box : second, 100).body, {
            headers: { "Content-Type": "application/octet-stream" },
          }),
        transformImage: async (input, options) => {
          await new Response(input).arrayBuffer();
          return new Response("transformed", { headers: { "Content-Type": options.format } });
        },
      });
      expect(response.status, String(second.byteLength)).toBe(status);
      expect(await response.text(), String(second.byteLength)).toBe(body);
    }
  });

  it("serves a source fetched again by its bytes, whatever length it declares", async () => {
    const box = new Uint8Array(20_000);
    box.set([0, 0, 0x4e, 0x20, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66]);
    let fetches = 0;
    // Served as-is, as without an optimizer, so the type decides the response.
    const response = await handleImageOptimization(imageRequest, {
      fetchAsset: async () =>
        new Response(chunkedSource(box, 100).body, {
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Length": fetches++ === 0 ? String(box.byteLength) : "1000",
          },
        }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/avif");
    expect((await response.arrayBuffer()).byteLength).toBe(box.byteLength);
  });

  it("serves a source fetched again that ends at its ftyp box, however the first was chunked", async () => {
    const box = new Uint8Array(20_000);
    box.set([0, 0, 0x4e, 0x20, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66]);
    const first = new Uint8Array(20_001);
    first.set(box);
    let fetches = 0;
    const response = await handleImageOptimization(imageRequest, {
      fetchAsset: async () => {
        const chunks = fetches++ === 0 ? [first.subarray(0, 1_000), first.subarray(1_000)] : [box];
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              const chunk = chunks.shift();
              if (chunk) controller.enqueue(chunk);
              else controller.close();
            },
          }),
          { headers: { "Content-Type": "application/octet-stream" } },
        );
      },
      transformImage: async (input, options) => {
        await new Response(input).arrayBuffer();
        return new Response("transformed", { headers: { "Content-Type": options.format } });
      },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("transformed");
  });

  it("cancels a source it rejects once it reads past the limit", async () => {
    for (const body of [SVG, "<!DOCTYPE html><p>page</p>"]) {
      let cancelled = false;
      const response = await handleImageOptimization(
        imageRequest,
        {
          fetchAsset: async () =>
            new Response(
              new ReadableStream<Uint8Array>({
                // More than detection reads, and never closed.
                start(controller) {
                  controller.enqueue(new TextEncoder().encode(body.padEnd(2_000)));
                },
                cancel() {
                  cancelled = true;
                },
              }),
              { headers: { "Content-Type": "image/png" } },
            ),
        },
        undefined,
        { maximumResponseBody: 1_500 },
      );
      expect(response.status).toBe(413);
      expect(cancelled, body).toBe(true);
    }
  });

  it("labels an image by its bytes rather than its Content-Type", async () => {
    const response = await handleImageOptimization(imageRequest, {
      fetchAsset: source(STATIC_GIF, "image/jpeg").fetchAsset,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/gif");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(STATIC_GIF);
  });
});
