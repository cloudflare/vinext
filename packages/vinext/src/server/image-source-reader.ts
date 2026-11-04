/**
 * Streamed reads of an image source for the image optimization endpoint.
 *
 * Animation detection parses a GIF, PNG or WebP source as it streams in rather
 * than buffering it, so a large source cannot exhaust a Worker isolate's
 * memory. Only the source's first bytes are kept, to replay without a refetch.
 */

/** Most bytes of a source kept to replay it after animation detection. */
const HELD_SOURCE_LIMIT = 1_048_576;

/** Thrown once a source grows past `images.maximumResponseBody`. */
export class ImageSourceTooLargeError extends Error {
  constructor() {
    super("Image source exceeds images.maximumResponseBody");
  }
}

export class ImageSourceReader {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #limit: number;
  #read = 0;
  #done = false;
  #cancelled = false;
  #tooLarge = false;
  // Chunks a parse can still reach, the first starting at #windowStart.
  #window: Uint8Array[] = [];
  #windowStart = 0;
  #windowEnd = 0;
  // The source's first chunks, or null once they pass HELD_SOURCE_LIMIT.
  #held: Uint8Array[] | null = [];
  #replayed = false;

  constructor(body: ReadableStream<Uint8Array>, limit: number) {
    this.#reader = body.getReader();
    this.#limit = limit;
  }

  /** Whether the source has grown past the limit. */
  get tooLarge(): boolean {
    return this.#tooLarge;
  }

  /** Whether the source has been read to its end, within the limit. */
  get readWhole(): boolean {
    return this.#done;
  }

  /** The source's length once it has all been read and held, else null. */
  get completeLength(): number | null {
    return this.#done && this.#held ? this.#read : null;
  }

  /** Stop reading the source without waiting on its cancellation. */
  cancel(): void {
    this.#cancelled = true;
    this.#reader.cancel().catch(() => {});
  }

  /** Up to `length` bytes at `offset`, fewer where the source ends. */
  async bytes(offset: number, length: number): Promise<Uint8Array> {
    const end = offset + length;
    await this.#reach(offset, end);
    const available = Math.min(end, this.#windowEnd);
    const bytes = new Uint8Array(Math.max(0, available - offset));
    let start = this.#windowStart;
    for (const chunk of this.#window) {
      if (start >= available) break;
      const from = Math.max(offset - start, 0);
      const to = Math.min(available - start, chunk.byteLength);
      if (from < to) bytes.set(chunk.subarray(from, to), start + from - offset);
      start += chunk.byteLength;
    }
    return bytes;
  }

  /** The byte at `offset`, or undefined past the source's end. */
  async byte(offset: number): Promise<number | undefined> {
    return (await this.bytes(offset, 1))[0];
  }

  /**
   * The whole source as a stream, replaying the bytes already read, or null
   * once they are no longer all held. An incompletely read source replays
   * once; the rest streams from the source, still within the limit, and is
   * held too while the whole source fits.
   */
  body(): ReadableStream<Uint8Array> | null {
    const held = this.#held;
    if (held === null || (this.#replayed && !this.#done)) return null;
    this.#replayed = true;
    this.#window = [];
    let index = 0;
    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        if (index < held.length) {
          controller.enqueue(held[index++]);
          return;
        }
        const chunk = await this.#next();
        if (!chunk) return controller.close();
        this.#hold(chunk);
        index = held.length;
        controller.enqueue(chunk);
      },
      cancel: (reason) => {
        this.#cancelled = true;
        return this.#reader.cancel(reason);
      },
    });
  }

  async #next(): Promise<Uint8Array | undefined> {
    if (this.#done) return undefined;
    const { done, value } = await this.#reader.read();
    if (done) {
      // A read pending as the source is cancelled ends it short, not whole.
      this.#done = !this.#cancelled;
      return undefined;
    }
    this.#read += value.byteLength;
    if (this.#read > this.#limit) {
      this.#tooLarge = true;
      this.cancel();
      throw new ImageSourceTooLargeError();
    }
    return value;
  }

  #hold(chunk: Uint8Array): void {
    if (!this.#held) return;
    if (this.#read <= HELD_SOURCE_LIMIT) this.#held.push(chunk);
    else this.#held = null;
  }

  /** Read until `end` is in the window, dropping chunks wholly before `offset`. */
  async #reach(offset: number, end: number): Promise<void> {
    if (offset < this.#windowStart) {
      throw new Error("Image source reads must not move backwards");
    }
    for (;;) {
      while (this.#window.length > 0 && this.#windowStart + this.#window[0].byteLength <= offset) {
        this.#windowStart += this.#window.shift()!.byteLength;
      }
      if (this.#windowEnd >= end) return;
      const chunk = await this.#next();
      if (!chunk) return;
      this.#hold(chunk);
      this.#window.push(chunk);
      this.#windowEnd += chunk.byteLength;
    }
  }
}

/**
 * A source read only once `body` is read, so one `body` never read can still
 * be served itself. `body` errors with `ImageSourceTooLargeError`, cancelling
 * the source, once it grows past `limit`.
 */
export class LimitedImageSource {
  readonly body: ReadableStream<Uint8Array>;
  /** Whether `body` has been read or cancelled. */
  disturbed = false;
  /** Whether the source has grown past the limit. */
  tooLarge = false;
  /** Whether the source has been read to its end, within the limit. */
  readWhole = false;

  constructor(source: ReadableStream<Uint8Array>, limit: number) {
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let read = 0;
    let cancelled = false;
    this.body = new ReadableStream<Uint8Array>(
      {
        pull: async (controller) => {
          this.disturbed = true;
          reader ??= source.getReader();
          const { done, value } = await reader.read();
          if (done) {
            // A read pending as `body` is cancelled ends it short, not whole.
            this.readWhole = !cancelled;
            return controller.close();
          }
          read += value.byteLength;
          if (read > limit) {
            this.tooLarge = true;
            reader.cancel().catch(() => {});
            controller.error(new ImageSourceTooLargeError());
            return;
          }
          controller.enqueue(value);
        },
        cancel: (reason) => {
          this.disturbed = true;
          cancelled = true;
          return reader ? reader.cancel(reason) : source.cancel(reason);
        },
      },
      { highWaterMark: 0 },
    );
  }
}
