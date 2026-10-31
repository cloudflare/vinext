import { Buffer, isUtf8 } from "node:buffer";
import {
  createNonceAttribute,
  escapeHtmlAttr,
  htmlTokenListContains,
  safeJsonStringify,
  scriptSafeJsonStringify,
} from "./html.js";
import {
  bytesToBase64,
  concatUint8Arrays,
  RSC_EMBEDDED_BINARY_CHUNK,
  type RscEmbeddedChunk,
} from "./app-rsc-embedded-chunks.js";
import { NAVIGATION_RUNTIME_SYMBOL_DESCRIPTION } from "../client/browser-globals.js";
import { getVinextRscCompatibilityId } from "./app-rsc-cache-busting.js";

// An embedded chunk before it's written: valid UTF-8 stays as bytes.
type PendingChunk = Uint8Array | Exclude<RscEmbeddedChunk, string>;

type RscEmbedTransform = {
  /** UTF-8 bytes of the scripts for the chunks read since the last flush. */
  flush(): Uint8Array | null;
  finalize(): Promise<Uint8Array>;
  /** Resolves when all raw bytes from the embed stream have been read. */
  getRawBuffer(): Promise<ArrayBuffer>;
};

type ReplayableRscEmbedTransform = RscEmbedTransform & {
  /**
   * The embed stream again from its start, for a render that replaces one
   * that already read it, or null once its bytes are released. `keepOpen`
   * leaves it open after the last byte, like a PPR fallback shell's SSR
   * stream, whose omitted references stay suspended.
   */
  replay(options?: { keepOpen?: boolean }): ReadableStream<Uint8Array> | null;
};

type RscEmbedTransformOptions = {
  /**
   * Mirror inline Flight chunks into Next.js's `self.__next_f` transport. A
   * function is checked at each flush; once it returns true, the chunks
   * already embedded are mirrored first.
   */
  mirrorNextFlight?: boolean | (() => boolean);
  scriptNonce?: string;
  getInitialNavigationCacheMetadata?: () => InitialNavigationCacheMetadata;
};

type HtmlInsertion = string | (() => string);
type InlineCssManifest = Record<string, string>;
export type InitialNavigationCacheMetadata = {
  kind: "dynamic" | "static";
  dynamicStaleTimeSeconds?: number;
  /**
   * Client reuse bound from the completed render's `cacheLife` — trustworthy
   * because the done-script is emitted only after the full RSC stream drains.
   */
  staleTimeSeconds?: number;
};
type InlineCssRewriteResult = {
  html: string;
  consumedPrependCss: boolean;
};

const RSC_EMBED_TEXT_BATCH_MAX_BYTES = 64 * 1024;

// React's edge renderer schedules render continuations on timer tasks. Dynamic
// SSR must let one such task run before the first stream pull, or fast Suspense
// boundaries can flush fallback HTML that would otherwise resolve in place.
export function waitAtLeastOneReactRenderTask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const NAVIGATION_RUNTIME_REFERENCE = `self[Symbol.for(${safeJsonStringify(
  NAVIGATION_RUNTIME_SYMBOL_DESCRIPTION,
)})]`;

export function navigationRuntimeRscBootstrapExpression(): string {
  return `((${NAVIGATION_RUNTIME_REFERENCE}??={bootstrap:{routeManifest:null},functions:{}}).bootstrap.rsc??={rsc:[]})`;
}

export function createNavigationRuntimeRscMetadataScript(
  params: Record<string, string | string[]>,
  nav: { pathname: string; searchParams: [string, string][] },
  dynamicStaleTimeSeconds?: number,
  searchParamsFromBrowser?: boolean,
): string {
  return (
    "Object.assign(" +
    navigationRuntimeRscBootstrapExpression() +
    ",{params:" +
    safeJsonStringify(params) +
    ",nav:" +
    safeJsonStringify(nav) +
    (searchParamsFromBrowser === undefined
      ? ""
      : ",searchParamsFromBrowser:" + safeJsonStringify(searchParamsFromBrowser)) +
    (dynamicStaleTimeSeconds === undefined
      ? ""
      : ",dynamicStaleTimeSeconds:" + safeJsonStringify(dynamicStaleTimeSeconds)) +
    "})"
  );
}

/**
 * The compatibility ID of the server rendering this page. The browser compares
 * RSC responses against it, so it is sent with the page rather than inlined
 * into the client bundle, where a per-build value would rename chunks on every
 * build. Static export skips the check, so its pages omit it.
 */
export function createNavigationRuntimeRscCompatibilityScript(): string {
  const compatibilityId = getVinextRscCompatibilityId();
  if (
    compatibilityId === null ||
    (process.env.NODE_ENV === "production" && process.env.__NEXT_CONFIG_OUTPUT === "export")
  ) {
    return "";
  }
  return (
    "Object.assign(" +
    navigationRuntimeRscBootstrapExpression() +
    ",{compatibilityId:" +
    safeJsonStringify(compatibilityId) +
    "})"
  );
}

/**
 * The query a client page read during SSR, for a render that turned dynamic
 * after its head told the browser to read the query from its own URL.
 */
export function createNavigationRuntimeRenderedSearchScript(search: string): string {
  return (
    "Object.assign(" +
    navigationRuntimeRscBootstrapExpression() +
    ",{renderedSearch:" +
    safeJsonStringify(search) +
    "})"
  );
}

function createNavigationRuntimeRscChunkScript(chunk: RscEmbeddedChunk): string {
  return (
    navigationRuntimeRscBootstrapExpression() + ".rsc.push(" + scriptSafeJsonStringify(chunk) + ")"
  );
}

// Flight text is embedded without decoding it to UTF-16. Its UTF-8 bytes are
// read as a latin1 "byte string" (one char per byte), escaped there and
// written back byte for byte. JSON.stringify only escapes ASCII characters, so
// every multi-byte sequence passes through intact and the result is the UTF-8
// encoding of scriptSafeJsonStringify(decodedText). U+2028 and U+2029 are
// matched as their UTF-8 sequences, E2 80 A8 and E2 80 A9.
const SCRIPT_UNSAFE_BYTE_STRING_RE =
  /<(?=!--|\/?[Ss][Cc][Rr][Ii][Pp][Tt])|\u00e2\u0080[\u00a8\u00a9]/g;

function escapeScriptUnsafeByteString(match: string): string {
  if (match === "<") return "\\u003c";
  return match.charCodeAt(2) === 0xa8 ? "\\u2028" : "\\u2029";
}

function bytesToByteString(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
}

const NON_ASCII_RE = /[\u0080-\uffff]/;

function textToByteString(text: string): string {
  return NON_ASCII_RE.test(text) ? Buffer.from(text, "utf8").toString("latin1") : text;
}

function byteStringToBytes(byteString: string): Uint8Array {
  // Unpooled, so a consumer that transfers the chunk's buffer can't detach
  // memory other Buffers share.
  const bytes = Buffer.allocUnsafeSlow(byteString.length);
  bytes.write(byteString, "latin1");
  return bytes;
}

const NAVIGATION_RUNTIME_RSC_PUSH_PREFIX = textToByteString(
  navigationRuntimeRscBootstrapExpression() + ".rsc.push(",
);

/** createNavigationRuntimeRscChunkScript for valid UTF-8 text, as a byte string. */
function createNavigationRuntimeRscTextChunkByteScript(text: Uint8Array): string {
  const json = JSON.stringify(bytesToByteString(text)).replace(
    SCRIPT_UNSAFE_BYTE_STRING_RE,
    escapeScriptUnsafeByteString,
  );
  return NAVIGATION_RUNTIME_RSC_PUSH_PREFIX + json + ")";
}

function createNavigationRuntimeRscDoneScript(metadata?: InitialNavigationCacheMetadata): string {
  const bootstrap = navigationRuntimeRscBootstrapExpression();
  return (
    (metadata === undefined
      ? ""
      : "Object.assign(" +
        bootstrap +
        "," +
        safeJsonStringify({
          initialCacheKind: metadata.kind,
          ...(metadata.dynamicStaleTimeSeconds === undefined
            ? {}
            : { dynamicStaleTimeSeconds: metadata.dynamicStaleTimeSeconds }),
          ...(metadata.staleTimeSeconds === undefined
            ? {}
            : { staleTimeSeconds: metadata.staleTimeSeconds }),
        }) +
        ");") +
    bootstrap +
    ".done=true"
  );
}

function createNextFlightBootstrapScript(): string {
  return "(self.__next_f=self.__next_f||[]).push([0])";
}

function createNextFlightChunkScript(chunk: RscEmbeddedChunk): string {
  const nextChunk = typeof chunk === "string" ? [1, chunk] : chunk;
  return "self.__next_f.push(" + safeJsonStringify(nextChunk) + ")";
}

function createNextFlightCleanupScript(): string {
  return 'self.addEventListener("DOMContentLoaded",()=>{if(self.__next_f?.push===Array.prototype.push)self.__next_f.length=0},{once:true})';
}

// The length of the UTF-8 character a byte starts. Continuation and invalid
// bytes count as one.
function utf8CharacterLength(byte: number): number {
  return byte >= 0xf8 ? 1 : byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
}

// Where a trailing, still incomplete UTF-8 character starts, or the byte length
// if there is none.
function utf8CompleteEnd(bytes: Uint8Array): number {
  const length = bytes.byteLength;
  // A UTF-8 character is at most 4 bytes, so only its last 3 can be missing.
  for (let index = length - 1; index >= 0 && index >= length - 3; index--) {
    const byte = bytes[index];
    if ((byte & 0xc0) === 0x80) continue;
    return index + utf8CharacterLength(byte) > length ? index : length;
  }
  return length;
}

/**
 * Create a helper that progressively embeds RSC chunks as inline <script> tags.
 * The browser entry turns the embedded chunks back into Uint8Array data.
 */
export function createRscEmbedTransform(
  embedStream: ReadableStream<Uint8Array>,
  optionsOrNonce: RscEmbedTransformOptions | string = {},
): ReplayableRscEmbedTransform {
  const options =
    typeof optionsOrNonce === "string" ? { scriptNonce: optionsOrNonce } : optionsOrNonce;
  const reader = embedStream.getReader();
  // Valid UTF-8 stays as bytes; the rest is already base64 chunks.
  let pendingChunks: PendingChunk[] = [];
  // How many raw chunks pendingChunks were decoded from.
  let pendingRawChunkCount = 0;
  const rawChunks: Uint8Array[] = [];
  // How many of rawChunks have been embedded, to replay them into a mirror
  // that starts mid-stream.
  let embeddedRawChunkCount = 0;
  let rawBufferTaken = false;
  let rawChunksReleased = false;
  let finalized = false;
  let reading = false;
  let readDone = false;
  let readError: { error: unknown } | null = null;
  const replays: { controller: ReadableStreamDefaultController<Uint8Array>; keepOpen: boolean }[] =
    [];
  let mirroredNextFlightBootstrap = false;
  const textDecoder = new TextDecoder("utf-8", { ignoreBOM: true });
  const nonceAttribute = textToByteString(createNonceAttribute(options.scriptNonce));

  function toBinaryChunk(bytes: Uint8Array): Exclude<RscEmbeddedChunk, string> {
    return [RSC_EMBEDDED_BINARY_CHUNK, bytesToBase64(bytes)];
  }

  function splitChunk(bytes: Uint8Array, chunks: PendingChunk[]): void {
    if (isUtf8(bytes)) {
      chunks.push(bytes);
      return;
    }
    // The chunk holds the body of a binary row, usually among text rows. A
    // newline is never part of a multi-byte character, so check line by line
    // and base64 only the lines that aren't text.
    const pushRange = (start: number, end: number, text: boolean): void => {
      const range = bytes.subarray(start, end);
      chunks.push(text ? range : toBinaryChunk(range));
    };
    let rangeStart = 0;
    let rangeIsText = false;
    let start = 0;
    while (start < bytes.byteLength) {
      const newline = bytes.indexOf(0x0a, start);
      const end = newline === -1 ? bytes.byteLength : newline + 1;
      const isText = isUtf8(bytes.subarray(start, end));
      if (start > rangeStart && isText !== rangeIsText) {
        pushRange(rangeStart, start, rangeIsText);
        rangeStart = start;
      }
      rangeIsText = isText;
      start = end;
    }
    pushRange(rangeStart, bytes.byteLength, rangeIsText);
  }

  /**
   * React cuts its output into fixed-size chunks wherever they fall, even
   * inside a character, so a chunk's last incomplete character is decoded with
   * the next chunk, which React writes in the same flush. Bytes are never held
   * past an embed flush, though: they may be the end of a binary row, which the
   * browser needs before React writes anything else. They're embedded as
   * binary then, and so are the bytes that complete them.
   */
  function createChunkDecoder() {
    let carry: Uint8Array | null = null;
    let missing = 0;
    return {
      decode(raw: Uint8Array, chunks: PendingChunk[]): void {
        let bytes = raw;
        if (missing > 0) {
          let count = 0;
          while (count < missing && count < bytes.byteLength && (bytes[count] & 0xc0) === 0x80) {
            count++;
          }
          missing = 0;
          if (count > 0) {
            chunks.push(toBinaryChunk(bytes.subarray(0, count)));
            bytes = bytes.subarray(count);
          }
        }
        if (carry) {
          bytes = concatUint8Arrays([carry, bytes]);
          carry = null;
        }
        const end = utf8CompleteEnd(bytes);
        if (end < bytes.byteLength) {
          carry = bytes.slice(end);
          bytes = bytes.subarray(0, end);
        }
        if (bytes.byteLength > 0) splitChunk(bytes, chunks);
      },
      flush(chunks: PendingChunk[]): void {
        if (!carry) return;
        chunks.push(toBinaryChunk(carry));
        missing = utf8CharacterLength(carry[0]) - carry.byteLength;
        carry = null;
      },
    };
  }
  const chunkDecoder = createChunkDecoder();

  function inlineScript(byteScript: string): string {
    return "<script" + nonceAttribute + ">" + byteScript + "</script>";
  }

  // getRawBuffer() keeps its own copy, but a mirror that may still start
  // replays rawChunks, so they're released only once it can't.
  function releaseRawChunks(): void {
    const mayStartMirror =
      typeof options.mirrorNextFlight === "function" && !mirroredNextFlightBootstrap && !finalized;
    if (rawBufferTaken && !mayStartMirror) {
      rawChunks.length = 0;
      rawChunksReleased = true;
    }
  }

  /** The mirror's opening scripts, as a byte string. */
  function startNextFlightMirror(): string {
    if (mirroredNextFlightBootstrap) return "";
    const mirror = options.mirrorNextFlight;
    if (mirror !== true && (typeof mirror !== "function" || !mirror())) return "";
    mirroredNextFlightBootstrap = true;
    let scripts =
      inlineScript(createNextFlightBootstrapScript()) +
      inlineScript(createNextFlightCleanupScript());
    const embeddedChunks: PendingChunk[] = [];
    const replayDecoder = createChunkDecoder();
    for (let index = 0; index < embeddedRawChunkCount; index++) {
      replayDecoder.decode(rawChunks[index], embeddedChunks);
    }
    replayDecoder.flush(embeddedChunks);
    for (const chunk of embeddedChunks) {
      const nextChunk = chunk instanceof Uint8Array ? textDecoder.decode(chunk) : chunk;
      scripts += inlineScript(textToByteString(createNextFlightChunkScript(nextChunk)));
    }
    releaseRawChunks();
    return scripts;
  }

  async function pumpReader(): Promise<void> {
    if (reading) return;
    reading = true;
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        rawChunks.push(result.value);
        for (const replay of replays) replay.controller.enqueue(result.value);
        chunkDecoder.decode(result.value, pendingChunks);
        pendingRawChunkCount++;
      }
      readDone = true;
      for (const replay of replays.splice(0)) {
        if (!replay.keepOpen) replay.controller.close();
      }
    } catch (error) {
      if (process.env.NODE_ENV !== "production") {
        console.warn("[vinext] RSC embed stream read error:", error);
      }
      readError = { error };
      for (const replay of replays.splice(0)) replay.controller.error(error);
      throw error;
    } finally {
      reading = false;
    }
  }

  const pumpPromise = pumpReader();

  /** Scripts for the chunks read since the last flush, as a byte string. */
  function flushByteScripts(): string {
    chunkDecoder.flush(pendingChunks);
    if (pendingChunks.length === 0) return "";

    const mirrorScripts = startNextFlightMirror();
    const chunks = pendingChunks;
    pendingChunks = [];
    embeddedRawChunkCount += pendingRawChunkCount;
    pendingRawChunkCount = 0;

    // React commonly emits one small Flight row per byte chunk. Embedding
    // each row in its own script makes large trees pay for thousands of
    // script wrappers, JSON serializations, and browser script executions.
    // Coalesce adjacent text here while preserving binary chunk boundaries.
    let scripts = mirrorScripts;
    let textChunks: Uint8Array[] = [];
    let textBytes = 0;
    const flushTextChunks = (): void => {
      if (textChunks.length === 0) return;
      const text = textChunks.length === 1 ? textChunks[0] : concatUint8Arrays(textChunks);
      textChunks = [];
      textBytes = 0;
      scripts += inlineScript(createNavigationRuntimeRscTextChunkByteScript(text));
      if (mirroredNextFlightBootstrap) {
        scripts += inlineScript(
          textToByteString(createNextFlightChunkScript(textDecoder.decode(text))),
        );
      }
    };
    for (const chunk of chunks) {
      if (chunk instanceof Uint8Array) {
        // Flush only between text chunks, which each end on a whole
        // character, so a batch never splits one. A single unusually large
        // chunk is no larger than the script vinext emitted before batching.
        if (textBytes > 0 && textBytes + chunk.byteLength > RSC_EMBED_TEXT_BATCH_MAX_BYTES) {
          flushTextChunks();
        }
        textChunks.push(chunk);
        textBytes += chunk.byteLength;
      } else {
        flushTextChunks();
        scripts += inlineScript(textToByteString(createNavigationRuntimeRscChunkScript(chunk)));
        if (mirroredNextFlightBootstrap) {
          scripts += inlineScript(textToByteString(createNextFlightChunkScript(chunk)));
        }
      }
    }
    flushTextChunks();
    return scripts;
  }

  return {
    flush(): Uint8Array | null {
      const scripts = flushByteScripts();
      return scripts ? byteStringToBytes(scripts) : null;
    },

    async finalize(): Promise<Uint8Array> {
      await pumpPromise;
      let scripts = flushByteScripts();
      scripts += startNextFlightMirror();
      finalized = true;
      releaseRawChunks();
      scripts += inlineScript(
        textToByteString(
          createNavigationRuntimeRscDoneScript(options.getInitialNavigationCacheMetadata?.()),
        ),
      );
      return byteStringToBytes(scripts);
    },

    async getRawBuffer(): Promise<ArrayBuffer> {
      await pumpPromise;
      const buffer = concatUint8Arrays(rawChunks);
      rawBufferTaken = true;
      releaseRawChunks();
      return buffer.buffer;
    },

    replay(replayOptions): ReadableStream<Uint8Array> | null {
      if (rawChunksReleased) return null;
      const keepOpen = replayOptions?.keepOpen === true;
      let replay: (typeof replays)[number] | undefined;
      return new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of rawChunks) controller.enqueue(chunk);
          if (readError) controller.error(readError.error);
          else if (readDone) {
            if (!keepOpen) controller.close();
          } else {
            replay = { controller, keepOpen };
            replays.push(replay);
          }
        },
        cancel() {
          const index = replay ? replays.indexOf(replay) : -1;
          if (index !== -1) replays.splice(index, 1);
        },
      });
    },
  };
}

// These `g`-flag regexes carry mutable `lastIndex` state. Every consumer below
// resets `lastIndex` before use, which is safe only because they run to
// completion synchronously within a single call. They must not be shared across
// concurrent/interleaved call paths.
const LINK_TAG_RE = /<link\b[^>]*>/gi;
const HTML_REWRITE_EXCLUDED_REGION_RE =
  /<!--[\s\S]*?-->|<(script|style|textarea|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const HTML_REWRITE_EXCLUDED_REGION_START_RE = /<!--|<(script|style|textarea|title)\b[^>]*>/gi;

// Pre-compiled close-tag regexes for the four tags captured by
// HTML_REWRITE_EXCLUDED_REGION_START_RE. `match[1]` is always one of these
// four names (lowercased below), so the lookup always hits. `i`-only flags —
// no `lastIndex` state — safe to share across concurrent requests/chunks.
const CLOSE_TAG_RES: Record<string, RegExp> = {
  script: /<\/script\s*>/i,
  style: /<\/style\s*>/i,
  textarea: /<\/textarea\s*>/i,
  title: /<\/title\s*>/i,
};

function getHtmlAttribute(tag: string, name: string): string | null {
  const attrRe = /\s([^\s"'=<>`]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match: RegExpExecArray | null;

  while ((match = attrRe.exec(tag)) !== null) {
    if (match[1]?.toLowerCase() !== name.toLowerCase()) continue;
    return match[2] ?? match[3] ?? match[4] ?? "";
  }

  return null;
}

function htmlAttributeHasToken(tag: string, name: string, token: string): boolean {
  return htmlTokenListContains(getHtmlAttribute(tag, name), token);
}

function getInlineCss(manifest: InlineCssManifest, href: string): string | null {
  if (Object.prototype.hasOwnProperty.call(manifest, href)) {
    return manifest[href] ?? "";
  }

  try {
    const pathname = new URL(href).pathname;
    if (Object.prototype.hasOwnProperty.call(manifest, pathname)) {
      return manifest[pathname] ?? "";
    }
  } catch {
    // Relative asset URLs are looked up by their emitted href.
  }

  return null;
}

// Module-level regex; consumers reset `lastIndex` before each scan. Same
// shared-state constraint as the other `g`-flag regexes above.
const TRAILING_LINK_OPEN_RE = /<link/gi;

function splitTrailingIncompleteLinkTag(html: string): { complete: string; trailing: string } {
  // Scan forward to find the last `<link` opening without allocating a
  // lowercased copy of `html` — this runs on every flush of the streaming
  // hot path, and `html` can be tens of KB.
  TRAILING_LINK_OPEN_RE.lastIndex = 0;
  let lastIndex = -1;
  let match: RegExpExecArray | null;
  while ((match = TRAILING_LINK_OPEN_RE.exec(html)) !== null) {
    lastIndex = match.index;
  }
  if (lastIndex === -1) return { complete: html, trailing: "" };
  const close = html.indexOf(">", lastIndex);
  if (close !== -1) return { complete: html, trailing: "" };
  return {
    complete: html.slice(0, lastIndex),
    trailing: html.slice(lastIndex),
  };
}

function findTrailingOpenHtmlRewriteExcludedRegionStart(html: string): number | null {
  let match: RegExpExecArray | null;

  HTML_REWRITE_EXCLUDED_REGION_START_RE.lastIndex = 0;
  while ((match = HTML_REWRITE_EXCLUDED_REGION_START_RE.exec(html)) !== null) {
    const start = match.index;
    if (match[0] === "<!--") {
      const close = html.indexOf("-->", HTML_REWRITE_EXCLUDED_REGION_START_RE.lastIndex);
      if (close === -1) return start;
      HTML_REWRITE_EXCLUDED_REGION_START_RE.lastIndex = close + 3;
      continue;
    }

    const tagName = match[1]?.toLowerCase();
    if (!tagName) continue;

    const closeTagRe = CLOSE_TAG_RES[tagName];
    if (!closeTagRe) continue;
    const close = closeTagRe.exec(html.slice(HTML_REWRITE_EXCLUDED_REGION_START_RE.lastIndex));
    if (!close) return start;
    HTML_REWRITE_EXCLUDED_REGION_START_RE.lastIndex += close.index + close[0].length;
  }

  return null;
}

function splitTrailingInlineCssRewriteBoundary(html: string): {
  complete: string;
  trailing: string;
} {
  const linkSplit = splitTrailingIncompleteLinkTag(html);
  const incompleteLinkStart = linkSplit.trailing ? linkSplit.complete.length : null;
  const openRegionStart = findTrailingOpenHtmlRewriteExcludedRegionStart(html);
  const trailingStart =
    incompleteLinkStart === null
      ? openRegionStart
      : openRegionStart === null
        ? incompleteLinkStart
        : Math.min(incompleteLinkStart, openRegionStart);

  if (trailingStart === null) return { complete: html, trailing: "" };

  return {
    complete: html.slice(0, trailingStart),
    trailing: html.slice(trailingStart),
  };
}

function escapeStyleText(css: string): string {
  return css.replace(/<\/style/gi, "<\\/style");
}

const CSS_PREPEND_UNSAFE_PREAMBLE_RE =
  /^\uFEFF?(?:\s|\/\*[\s\S]*?\*\/)*@(charset|import|layer|namespace)\b/i;

function canPrependCss(css: string): boolean {
  return !CSS_PREPEND_UNSAFE_PREAMBLE_RE.test(css);
}

function replaceLinkTags(html: string, replaceLinkTag: (tag: string) => string): string {
  LINK_TAG_RE.lastIndex = 0;
  return html.replace(LINK_TAG_RE, replaceLinkTag);
}

function replaceLinkTagsOutsideRawText(
  html: string,
  replaceLinkTag: (tag: string) => string,
): string {
  let rewritten = "";
  let cursor = 0;
  let match: RegExpExecArray | null;

  HTML_REWRITE_EXCLUDED_REGION_RE.lastIndex = 0;
  while ((match = HTML_REWRITE_EXCLUDED_REGION_RE.exec(html)) !== null) {
    rewritten += replaceLinkTags(html.slice(cursor, match.index), replaceLinkTag);
    rewritten += match[0];
    cursor = match.index + match[0].length;
  }

  const tail = html.slice(cursor);
  const openRegionStart = findTrailingOpenHtmlRewriteExcludedRegionStart(tail);
  if (openRegionStart === null) {
    return rewritten + replaceLinkTags(tail, replaceLinkTag);
  }

  return (
    rewritten +
    replaceLinkTags(tail.slice(0, openRegionStart), replaceLinkTag) +
    tail.slice(openRegionStart)
  );
}

/** The stylesheets `html` links or inlines, by their hrefs as written. */
export function collectStylesheetHrefs(html: string): Set<string> {
  const hrefs = new Set<string>();
  for (const [tag] of html.matchAll(/<(?:link|style)\b[^>]*>/g)) {
    if (tag.startsWith("<style")) {
      for (const href of getHtmlAttribute(tag, "data-href")?.split(/\s+/) ?? []) hrefs.add(href);
    } else if (htmlAttributeHasToken(tag, "rel", "stylesheet")) {
      const href = getHtmlAttribute(tag, "href");
      if (href) hrefs.add(href);
    }
  }
  return hrefs;
}

export function rewriteInlineCssStylesheetLinks(
  html: string,
  inlineCssManifest: InlineCssManifest | undefined,
  prependCss: string,
  ssrScriptNonce: string | undefined,
): InlineCssRewriteResult {
  if (!inlineCssManifest || Object.keys(inlineCssManifest).length === 0) {
    return { html, consumedPrependCss: false };
  }
  let consumedPrependCss = false;

  const rewritten = replaceLinkTagsOutsideRawText(html, (tag) => {
    if (!htmlAttributeHasToken(tag, "rel", "stylesheet")) return tag;

    const href = getHtmlAttribute(tag, "href");
    const precedence =
      getHtmlAttribute(tag, "data-precedence") ?? getHtmlAttribute(tag, "precedence");
    if (!href || !precedence) return tag;

    const css = getInlineCss(inlineCssManifest, href);
    if (css === null) return tag;

    // Prefer the link's own nonce if Fizz emitted one; otherwise fall back to
    // the SSR-time script/style nonce so sites with CSP `style-src 'nonce-…'`
    // policies don't block the inlined `<style>` block. The `<link>` tag this
    // replaces wasn't subject to inline-style CSP, but the new `<style>` is.
    const linkNonce = getHtmlAttribute(tag, "nonce");
    const effectiveNonce = linkNonce ?? ssrScriptNonce;
    const nonceAttr = effectiveNonce ? ` nonce="${escapeHtmlAttr(effectiveNonce)}"` : "";
    const shouldPrependCss = !consumedPrependCss && prependCss.length > 0 && canPrependCss(css);
    const cssPrefix = shouldPrependCss ? `${prependCss}\n` : "";
    consumedPrependCss ||= cssPrefix.length > 0;

    return (
      `<style data-vinext-inline-css${nonceAttr}` +
      ` data-precedence="${escapeHtmlAttr(precedence)}"` +
      ` data-href="${escapeHtmlAttr(href)}">` +
      `${escapeStyleText(cssPrefix + css)}</style>`
    );
  });

  return { html: rewritten, consumedPrependCss };
}

/**
 * Match the `<head ...>` opening tag in a chunk. Matches both bare `<head>`
 * and `<head class="foo">` shapes. Used to splice HTML immediately after the
 * opening tag so injected content runs before any React-emitted resource
 * hints (stylesheets, modulepreloads) that React Float hoists into `<head>`.
 */
const HEAD_OPEN_RE = /<head\b[^>]*>/;

/**
 * Final closing tags of the streamed HTML document. We track this suffix
 * separately so we can move it to the very end of the stream — trailing flight
 * chunks and preinit scripts emitted by `rscEmbed.finalize()` are appended in
 * `flush()`, which would otherwise land them after `</body></html>` and break
 * any consumer that asserts the document terminates with a well-formed close.
 *
 * Ported from Next.js: packages/next/src/server/stream-utils/node-web-streams-helper.ts
 * https://github.com/vercel/next.js/blob/canary/packages/next/src/server/stream-utils/node-web-streams-helper.ts
 * (see `createMoveSuffixStream` and `CLOSE_TAG`)
 */
const DOCUMENT_CLOSE_SUFFIX = "</body></html>";
const DOCUMENT_CLOSE_SUFFIX_BYTES = new TextEncoder().encode(DOCUMENT_CLOSE_SUFFIX);
const HEAD_CLOSE_BYTES = new TextEncoder().encode("</head>");

/**
 * Whether `chunks` end partway through a UTF-8 character, i.e. whether a
 * streaming TextDecoder may still be holding back their last bytes. Errs
 * towards true: when the batch has too few bytes to tell, the previous
 * batch's answer carries over.
 */
function endsWithIncompleteUtf8Character(
  chunks: readonly Uint8Array[],
  previousBatchEndedIncomplete: boolean,
): boolean {
  let continuationBytes = 0;
  for (let chunkIndex = chunks.length - 1; chunkIndex >= 0; chunkIndex--) {
    const chunk = chunks[chunkIndex];
    for (let index = chunk.byteLength - 1; index >= 0; index--) {
      const byte = chunk[index];
      if ((byte & 0xc0) !== 0x80) {
        const length = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
        return continuationBytes + 1 < length;
      }
      // A character has at most three continuation bytes.
      if (++continuationBytes === 3) return false;
    }
  }
  return previousBatchEndedIncomplete;
}

/**
 * Find an ASCII `pattern` in UTF-8 `bytes`, starting at `from`. ASCII bytes
 * never occur inside a multi-byte character, so every byte match is a match
 * in the decoded text too.
 */
function indexOfAsciiBytes(bytes: Uint8Array, pattern: Uint8Array, from: number): number {
  const last = bytes.byteLength - pattern.byteLength;
  search: for (let index = from; index <= last; index++) {
    for (let offset = 0; offset < pattern.byteLength; offset++) {
      if (bytes[index + offset] !== pattern[offset]) continue search;
    }
    return index;
  }
  return -1;
}

/**
 * Create the tick-buffered HTML transform that injects RSC scripts between
 * React Fizz flush cycles without corrupting split HTML chunks.
 *
 * Two insertion points are supported in tandem:
 *
 *  - `injectHTML` is emitted immediately before `</head>`. This is where the
 *    bulk of vinext's head additions live (RSC navigation runtime metadata,
 *    bootstrap modulepreload, server-inserted HTML, font preloads, etc.).
 *  - `injectAfterHeadOpenHTML` is emitted immediately after the `<head ...>`
 *    opening tag so the content runs before any React-emitted resource
 *    hints. This is where inline `<Script strategy="beforeInteractive">`
 *    captures land so the no-flash dark-mode pattern works.
 *
 * Fallback behaviour differs by insertion point:
 *
 *  - `injectHTML` is emitted at end-of-stream by the `flush` handler when no
 *    chunk ever contained `</head>` — callers still see the payload on
 *    highly fragmented streams (just at the end of the body rather than in
 *    the head).
 *  - `injectAfterHeadOpenHTML` is silently dropped when `<head ...>` is not
 *    found in a discoverable chunk. Emitting it at end-of-stream would put
 *    it after the document body, defeating the point — the splice has to
 *    happen before resource hints to be useful, so the safer behaviour is
 *    to no-op and let the user-rendered Script (in its source-order
 *    position) ship as-is.
 */
export function createTickBufferedTransform(
  rscEmbed: RscEmbedTransform,
  injectHTML: string | ((headHtml: string) => string) = "",
  injectAfterHeadOpenHTML: HtmlInsertion = "",
  inlineCssManifest?: InlineCssManifest,
  inlineCssPrependCss = "",
  inlineCssPrependFallbackHTML = "",
  inlineCssScriptNonce?: string,
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const insertsPerFlush = typeof injectHTML === "function";
  let injected = false;
  let preHeadInjected = false;
  let suffixStripped = false;
  let buffered: string[] = [];
  // Fizz's bytes for `buffered`, kept so text the transform leaves unchanged
  // can be forwarded without re-encoding it. Unused with inline CSS, which
  // may rewrite any batch.
  let bufferedBytes: Uint8Array[] = [];
  let decoderMayHoldBytes = false;
  let pendingHtml = "";
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  // Computed once at transform creation: every flush is a hot path, so we
  // avoid re-running Object.keys() on the manifest per chunk. Gates both the
  // split-link boundary buffering and the inline-css link rewrite below.
  const hasInlineCssManifest =
    inlineCssManifest !== undefined && Object.keys(inlineCssManifest).length > 0;

  /**
   * Return this batch's bytes when they are exactly the UTF-8 encoding of its
   * decoded text, so they can stand in for re-encoding that text. That needs
   * the batch to start and end on character boundaries (the decoder holds no
   * bytes across it) and to contain no invalid UTF-8, which the decoder would
   * have replaced with U+FFFD.
   */
  const takeBufferedBytes = (html: string): Uint8Array | null => {
    if (hasInlineCssManifest) return null;
    const chunks = bufferedBytes;
    bufferedBytes = [];
    const startsMidCharacter = decoderMayHoldBytes;
    decoderMayHoldBytes = endsWithIncompleteUtf8Character(chunks, decoderMayHoldBytes);
    if (startsMidCharacter || decoderMayHoldBytes || html.includes("\uFFFD")) return null;
    return chunks.length === 1 ? chunks[0] : concatUint8Arrays(chunks);
  };

  /**
   * Byte form of `stripDocumentCloseSuffix(html.slice(htmlStart))` for a batch
   * whose bytes encode `html`: returns the bytes from `byteStart` (the byte
   * offset of `htmlStart`) with the first suffix removed.
   */
  const stripDocumentCloseSuffixBytes = (
    bytes: Uint8Array,
    byteStart: number,
    html: string,
    htmlStart: number,
  ): Uint8Array => {
    const rest = bytes.subarray(byteStart);
    if (suffixStripped) return rest;
    const index = html.indexOf(DOCUMENT_CLOSE_SUFFIX, htmlStart);
    if (index === -1) return rest;
    suffixStripped = true;
    // UTF-8 never takes fewer bytes than UTF-16 code units, so the suffix's
    // byte offset is at least this, and the first byte match from here is it.
    const byteIndex = indexOfAsciiBytes(
      bytes,
      DOCUMENT_CLOSE_SUFFIX_BYTES,
      byteStart + index - htmlStart,
    );
    const before = bytes.subarray(byteStart, byteIndex);
    const after = bytes.subarray(byteIndex + DOCUMENT_CLOSE_SUFFIX_BYTES.byteLength);
    // React writes the suffix last, so usually nothing follows it.
    return after.byteLength === 0 ? before : concatUint8Arrays([before, after]);
  };

  /**
   * Strip the first occurrence of `</body></html>` from `chunk` so it can be
   * re-emitted at the very end of the stream. Returns the rewritten chunk and
   * a flag indicating whether a suffix was found. If `suffixStripped` is
   * already true (i.e. an earlier chunk contained the suffix), this is a
   * no-op — additional matches in later chunks shouldn't happen in practice,
   * but we leave them alone to avoid corrupting unexpected output.
   */
  const stripDocumentCloseSuffix = (chunk: string): string => {
    if (suffixStripped) return chunk;
    const index = chunk.indexOf(DOCUMENT_CLOSE_SUFFIX);
    if (index === -1) return chunk;
    suffixStripped = true;
    return chunk.slice(0, index) + chunk.slice(index + DOCUMENT_CLOSE_SUFFIX.length);
  };
  const readInsertion = (headHtml = ""): string =>
    typeof injectHTML === "function" ? injectHTML(headHtml) : injectHTML;
  const readPreHeadInsertion = (): string =>
    typeof injectAfterHeadOpenHTML === "function"
      ? injectAfterHeadOpenHTML()
      : injectAfterHeadOpenHTML;
  const readInlineCssPrependFallback = (): string => {
    if (!inlineCssPrependCss || !inlineCssPrependFallbackHTML) return "";
    inlineCssPrependCss = "";
    return inlineCssPrependFallbackHTML;
  };
  const emitInsertion = (controller: TransformStreamDefaultController<Uint8Array>): void => {
    const insertion = readInlineCssPrependFallback() + readInsertion();
    if (insertion) {
      controller.enqueue(encoder.encode(insertion));
    }
  };

  /**
   * Splice the pre-head insertion (typically captured beforeInteractive inline
   * scripts) immediately after the `<head ...>` opening tag. Returns the
   * rewritten chunk and a flag indicating whether the splice happened, so the
   * caller can mark `preHeadInjected` and stop scanning further chunks.
   *
   * NOTE: This is called only when `<head ...>` lies fully inside the current
   * tick-buffered batch. We deliberately avoid retaining arbitrary output until
   * a future chunk completes `<head ...>`, which would delay TTFB and complicate
   * the existing `</head>` injection path. In practice React Fizz emits the
   * opening shell as a single batch.
   */
  const spliceAfterHeadOpen = (
    chunk: string,
  ): { chunk: string; spliced: boolean; insertionEnd: number } => {
    if (preHeadInjected) return { chunk, spliced: false, insertionEnd: 0 };
    const insertion = readPreHeadInsertion();
    if (!insertion) return { chunk, spliced: false, insertionEnd: 0 };
    const match = HEAD_OPEN_RE.exec(chunk);
    if (!match) return { chunk, spliced: false, insertionEnd: 0 };
    const insertAt = match.index + match[0].length;
    return {
      chunk: chunk.slice(0, insertAt) + insertion + chunk.slice(insertAt),
      spliced: true,
      insertionEnd: insertAt + insertion.length,
    };
  };

  const flushBuffered = (
    controller: TransformStreamDefaultController<Uint8Array>,
    final = false,
  ): void => {
    if (buffered.length === 0 && !pendingHtml) return;
    const rawHtml = pendingHtml + buffered.join("");
    buffered = [];
    pendingHtml = "";
    const rawBytes = takeBufferedBytes(rawHtml);

    const split =
      final || !hasInlineCssManifest
        ? { complete: rawHtml, trailing: "" }
        : splitTrailingInlineCssRewriteBoundary(rawHtml);
    if (split.trailing) {
      pendingHtml = split.trailing;
    }
    if (!split.complete) return;

    if (injected && insertsPerFlush) {
      // Emit newly collected server-inserted HTML before the next Fizz HTML
      // batch so CSS-in-JS styles precede the elements they style.
      emitInsertion(controller);
    }

    const inlineCssResult = hasInlineCssManifest
      ? rewriteInlineCssStylesheetLinks(
          split.complete,
          inlineCssManifest,
          inlineCssPrependCss,
          inlineCssScriptNonce,
        )
      : { html: split.complete, consumedPrependCss: false };
    if (inlineCssResult.consumedPrependCss) {
      inlineCssPrependCss = "";
    }

    let working = inlineCssResult.html;
    // While `working` is still Fizz's text, its bytes are forwarded instead of
    // re-encoding it; only HTML the transform splices in is encoded.
    const unchangedBytes = working === rawHtml ? rawBytes : null;
    // Where Fizz's text resumes in `working` after a pre-head splice.
    let rawTextStart = 0;
    if (!preHeadInjected) {
      const result = spliceAfterHeadOpen(working);
      if (result.spliced) {
        working = result.chunk;
        preHeadInjected = true;
        rawTextStart = result.insertionEnd;
      }
    }
    if (!injected) {
      const headEnd = working.indexOf("</head>");
      if (headEnd !== -1) {
        const before = working.slice(0, headEnd);
        if (unchangedBytes && headEnd >= rawTextStart) {
          // Encode the head with its insertions; forward the bytes from
          // `</head>` on. A text offset is a lower bound for its byte offset
          // (see stripDocumentCloseSuffixBytes).
          const rawHeadEnd = headEnd - (working.length - rawHtml.length);
          const byteHeadEnd = indexOfAsciiBytes(unchangedBytes, HEAD_CLOSE_BYTES, rawHeadEnd);
          controller.enqueue(
            encoder.encode(before + readInlineCssPrependFallback() + readInsertion(before)),
          );
          controller.enqueue(
            stripDocumentCloseSuffixBytes(unchangedBytes, byteHeadEnd, rawHtml, rawHeadEnd),
          );
          injected = true;
          return;
        }
        const after = stripDocumentCloseSuffix(working.slice(headEnd));
        controller.enqueue(
          encoder.encode(before + readInlineCssPrependFallback() + readInsertion(before) + after),
        );
        injected = true;
        return;
      }
    } else if (unchangedBytes && rawTextStart === 0) {
      // Only after `</head>`: earlier batches stay on the text path, which
      // drops a leading byte order mark the way the decoder does.
      controller.enqueue(stripDocumentCloseSuffixBytes(unchangedBytes, 0, rawHtml, 0));
      return;
    }
    working = stripDocumentCloseSuffix(working);
    controller.enqueue(encoder.encode(working));
  };

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffered.push(decoder.decode(chunk, { stream: true }));
      if (!hasInlineCssManifest) bufferedBytes.push(chunk);

      if (timeoutId !== null) return;

      timeoutId = setTimeout(() => {
        try {
          flushBuffered(controller);

          const rscScripts = rscEmbed.flush();
          if (rscScripts) {
            controller.enqueue(rscScripts);
          }
        } catch {
          // Stream was cancelled between when the timeout was registered and
          // when it fired (e.g. client disconnected, health-check cancelled
          // the response body). Ignore — the stream is already closed.
        }

        timeoutId = null;
      }, 0);
    },

    async flush(controller) {
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      const remainder = decoder.decode();
      if (remainder) {
        buffered.push(remainder);
      }

      flushBuffered(controller, true);

      if (!injected) {
        emitInsertion(controller);
        injected = true;
      } else if (insertsPerFlush) {
        emitInsertion(controller);
      }

      controller.enqueue(await rscEmbed.finalize());

      // Emit `</body></html>` last so the document always terminates with a
      // well-formed close, after any trailing flight chunks / preinit scripts.
      // Mirrors Next.js's `createMoveSuffixStream` behaviour (#1532).
      controller.enqueue(encoder.encode(DOCUMENT_CLOSE_SUFFIX));
    },
  });
}
