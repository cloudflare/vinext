import { describe, expect, it, vi } from "vite-plus/test";
import {
  appendRscCompletionMetadata,
  extractRscCompletionMetadata,
  stripRscCompletionMetadata,
  stripRscCompletionMetadataResponse,
} from "../packages/vinext/src/server/rsc-completion-metadata.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function stream(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function byteStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

describe("RSC completion metadata", () => {
  it("appends and extracts the completed dynamic stale bound", async () => {
    const body = appendRscCompletionMetadata(stream(["flight-", "payload"]), () => ({
      dynamicStaleTimeSeconds: 0,
    }));
    const encoded = await new Response(body).arrayBuffer();
    const extracted = extractRscCompletionMetadata(encoded);

    expect(decoder.decode(extracted.buffer)).toBe("flight-payload");
    expect(extracted.metadata).toEqual({ dynamicStaleTimeSeconds: 0 });
  });

  it("strips the footer without exposing it to the Flight decoder stream", async () => {
    const body = appendRscCompletionMetadata(stream(["a".repeat(300), "tail"]), () => ({
      dynamicStaleTimeSeconds: 12,
    }));
    const stripped = stripRscCompletionMetadata(body);

    await expect(new Response(stripped).text()).resolves.toBe(`${"a".repeat(300)}tail`);
  });

  it("delivers a small Flight shell before the source stream completes", async () => {
    let sourceController!: ReadableStreamDefaultController<Uint8Array>;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        sourceController = controller;
      },
    });
    const reader = stripRscCompletionMetadata(source).getReader();

    sourceController.enqueue(encoder.encode("flight-shell"));
    const first = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("Flight shell was withheld until stream completion")),
          1_000,
        ),
      ),
    ]);

    expect(first.done).toBe(false);
    expect(decoder.decode(first.value)).toBe("flight-shell");
    sourceController.enqueue(encoder.encode("flight-tail"));
    sourceController.close();
    await expect(
      new Response(
        new ReadableStream({
          async pull(controller) {
            const next = await reader.read();
            if (next.done) controller.close();
            else controller.enqueue(next.value);
          },
        }),
      ).text(),
    ).resolves.toBe("flight-tail");
  });

  it("passes ordinary Flight chunks through without copying their backing buffer", async () => {
    const chunk = encoder.encode("ordinary-flight-chunk");
    const reader = stripRscCompletionMetadata(byteStream([chunk])).getReader();

    const first = await reader.read();

    expect(first.done).toBe(false);
    expect(first.value?.buffer).toBe(chunk.buffer);
  });

  it("strips completion framing across every byte boundary", async () => {
    // Includes both bytes reserved by the footer prefix. Byte-stuffing makes
    // this payload unambiguous rather than relying on a magic-string collision
    // being unlikely.
    const payload = Uint8Array.from([1, 2, 0xff, 0x00, 3, 0xff, 0xff, 4]);
    const encoded = new Uint8Array(
      await new Response(
        appendRscCompletionMetadata(byteStream([payload]), () => ({
          dynamicStaleTimeSeconds: 60,
        })),
      ).arrayBuffer(),
    );

    for (let split = 1; split < encoded.byteLength; split++) {
      const rechunked = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoded.slice(0, split));
          controller.enqueue(encoded.slice(split));
          controller.close();
        },
      });
      const decoded = new Uint8Array(
        await new Response(stripRscCompletionMetadata(rechunked)).arrayBuffer(),
      );
      expect(decoded, `split at byte ${split}`).toEqual(payload);
    }
  });

  it("round-trips reserved marker bytes when no footer is appended", async () => {
    const payload = Uint8Array.from([0xff, 0x00, 0xff, 0xff, 1]);
    const encoded = new Uint8Array(
      await new Response(
        appendRscCompletionMetadata(byteStream([payload]), () => undefined),
      ).arrayBuffer(),
    );

    const decoded = new Uint8Array(
      await new Response(stripRscCompletionMetadata(byteStream([encoded]))).arrayBuffer(),
    );
    expect(decoded).toEqual(payload);
    expect(new Uint8Array(extractRscCompletionMetadata(encoded.buffer).buffer)).toEqual(payload);
  });

  it("round-trips a short footerless payload containing only a reserved byte", async () => {
    const payload = Uint8Array.of(0xff);
    const encoded = new Uint8Array(
      await new Response(
        appendRscCompletionMetadata(byteStream([payload]), () => undefined),
      ).arrayBuffer(),
    );

    expect(encoded).toEqual(Uint8Array.of(0xff, 0xff));
    expect(new Uint8Array(extractRscCompletionMetadata(encoded.buffer).buffer)).toEqual(payload);
    await expect(
      new Response(stripRscCompletionMetadata(byteStream([encoded]))).arrayBuffer(),
    ).resolves.toEqual(payload.buffer);
  });

  it("rejects invalid escape sequences in buffered and streaming decoders", async () => {
    const invalid = Uint8Array.of(0xff, 0x01);

    expect(() => extractRscCompletionMetadata(invalid.buffer)).toThrow(
      "Invalid RSC completion metadata escape sequence",
    );
    await expect(
      new Response(stripRscCompletionMetadata(byteStream([invalid]))).arrayBuffer(),
    ).rejects.toThrow("Invalid RSC completion metadata escape sequence");
  });

  it("rejects a truncated footer", async () => {
    const encoded = new Uint8Array(
      await new Response(
        appendRscCompletionMetadata(stream(["flight"]), () => ({
          dynamicStaleTimeSeconds: 60,
        })),
      ).arrayBuffer(),
    );
    const truncated = byteStream([encoded.slice(0, -1)]);

    expect(() => extractRscCompletionMetadata(encoded.slice(0, -1).buffer)).toThrow(
      "Invalid or truncated RSC completion metadata footer",
    );
    await expect(new Response(stripRscCompletionMetadata(truncated)).arrayBuffer()).rejects.toThrow(
      "Invalid or truncated RSC completion metadata footer",
    );
  });

  it("rejects oversized footer frames in buffered and streaming decoders", async () => {
    const oversized = new Uint8Array(257);
    oversized.set([0xff, 0x00]);

    expect(() => extractRscCompletionMetadata(oversized.buffer)).toThrow(
      "RSC completion metadata exceeded its framing limit",
    );
    await expect(
      new Response(stripRscCompletionMetadata(byteStream([oversized]))).arrayBuffer(),
    ).rejects.toThrow("RSC completion metadata exceeded its framing limit");
  });

  it("rejects multiple footer frames", async () => {
    const first = new Uint8Array(
      await new Response(
        appendRscCompletionMetadata(stream(["first"]), () => ({
          dynamicStaleTimeSeconds: 60,
        })),
      ).arrayBuffer(),
    );
    const second = new Uint8Array(
      await new Response(
        appendRscCompletionMetadata(stream(["second"]), () => ({
          dynamicStaleTimeSeconds: 60,
        })),
      ).arrayBuffer(),
    );
    const combined = new Uint8Array(first.byteLength + second.byteLength);
    combined.set(first, 0);
    combined.set(second, first.byteLength);

    expect(() => extractRscCompletionMetadata(combined.buffer)).toThrow(
      "Invalid or truncated RSC completion metadata footer",
    );
    await expect(
      new Response(stripRscCompletionMetadata(byteStream([combined]))).arrayBuffer(),
    ).rejects.toThrow("Invalid or truncated RSC completion metadata footer");
  });

  it("propagates cancellation through framing and stripping", async () => {
    const cancel = vi.fn();
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("flight"));
      },
      cancel,
    });
    const reader = stripRscCompletionMetadata(
      appendRscCompletionMetadata(source, () => undefined),
    ).getReader();

    await expect(reader.read()).resolves.toMatchObject({ done: false });
    await reader.cancel("navigation superseded");
    expect(cancel).toHaveBeenCalledWith("navigation superseded");
  });

  it("propagates source errors through framing and stripping", async () => {
    const failure = new Error("Flight source failed");
    let fail!: () => void;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("flight"));
        fail = () => controller.error(failure);
      },
    });
    const reader = stripRscCompletionMetadata(
      appendRscCompletionMetadata(source, () => undefined),
    ).getReader();

    await expect(reader.read()).resolves.toMatchObject({ done: false });
    fail();
    await expect(reader.read()).rejects.toBe(failure);
  });

  it("passes a static completed stream through byte-for-byte", async () => {
    const body = appendRscCompletionMetadata(stream(["static-flight"]), () => undefined);
    const encoded = await new Response(body).arrayBuffer();
    const extracted = extractRscCompletionMetadata(encoded);

    expect(decoder.decode(extracted.buffer)).toBe("static-flight");
    expect(extracted.metadata).toBeUndefined();
  });

  it("normalizes an advertised completion response before a Flight consumer reads it", async () => {
    const response = new Response(
      appendRscCompletionMetadata(stream(["hmr-flight"]), () => ({
        dynamicStaleTimeSeconds: 0,
      })),
      {
        headers: {
          "X-Test": "preserved",
          "X-Vinext-Rsc-Completion-Metadata": "1",
        },
        status: 206,
        statusText: "Partial Content",
      },
    );

    const normalized = stripRscCompletionMetadataResponse(response);

    await expect(normalized.text()).resolves.toBe("hmr-flight");
    expect(normalized.status).toBe(206);
    expect(normalized.statusText).toBe("Partial Content");
    expect(normalized.headers.get("X-Test")).toBe("preserved");
  });

  it("does not disturb responses without the completion protocol marker", () => {
    const response = new Response("plain-flight");

    expect(stripRscCompletionMetadataResponse(response)).toBe(response);
  });
});
