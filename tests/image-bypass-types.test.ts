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

function avif(majorBrand: string, compatibleBrands: string): Uint8Array<ArrayBuffer> {
  const size = 16 + compatibleBrands.length;
  return new Uint8Array([
    0,
    0,
    0,
    size,
    ...new TextEncoder().encode(`ftyp${majorBrand}\0\0\0\0${compatibleBrands}mdat`),
  ]);
}

const STATIC_AVIF = avif("avif", "mif1");
const ANIMATED_AVIF = avif("avis", "avifmsf1");

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

  it("recognizes the AVIF sequence brand in the file type box", async () => {
    expect(await isAnimated(ANIMATED_AVIF)).toBe(true);
    expect(await isAnimated(avif("avif", "mif1avis"))).toBe(true);
    expect(await isAnimated(STATIC_AVIF)).toBe(false);
    // The next box is outside ftyp, even if its bytes happen to say avis.
    const outsideFileType = STATIC_AVIF.slice();
    outsideFileType.set(new TextEncoder().encode("avis"), 20);
    expect(await isAnimated(outsideFileType)).toBe(false);
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
    ["AVIF", ANIMATED_AVIF, "image/avif"],
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

  it.each([
    ["gif", STATIC_GIF, "image/gif"],
    ["avif", STATIC_AVIF, "image/avif"],
  ] as const)("transforms a still %s from its replayed bytes", async (extension, bytes, type) => {
    const { handlers: imageHandlers, transformed } = handlers(bytes, type);
    const response = await handleImageOptimization(
      imageRequest(`/still.${extension}`),
      imageHandlers,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("transformed");
    expect(response.headers.get("Content-Type")).toBe("image/avif");
    expect(transformed).toEqual([new TextDecoder().decode(bytes)]);
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

  it("rejects a source that declares more than the limit without reading it", async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(1));
      },
    });
    const response = await handleImageOptimization(imageRequest, {
      fetchAsset: async () =>
        new Response(body, {
          status: 200,
          headers: { "Content-Type": "image/png", "Content-Length": "50000001" },
        }),
      transformImage,
    });
    expect(response.status).toBe(413);
    expect(await response.text()).toBe(TOO_LARGE);
    expect(pulled).toBeLessThanOrEqual(1);
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
    await expect(streamed.arrayBuffer()).rejects.toThrow();
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
    expect(
      sniffImageContentType(bytes(0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63)),
    ).toBe("image/heic");
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
    for (const body of ["<!DOCTYPE html><p>page</p>", "<svg onload=alert(1)></svg>"]) {
      const response = await handleImageOptimization(imageRequest("/page"), {
        fetchAsset: async () =>
          new Response(body, { status: 200, headers: { "Content-Type": "text/html" } }),
      });
      expect(response.status, body).toBe(400);
      expect(await response.text()).toBe('"url" parameter is valid but image type is not allowed');
    }
  });
});
