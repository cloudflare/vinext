import {
  createInlineScriptTag,
  escapeHtmlAttr,
  htmlTokenListContains,
  safeJsonStringify,
} from "./html.js";
import {
  bytesToBase64,
  concatUint8Arrays,
  RSC_EMBEDDED_BINARY_CHUNK,
  type RscEmbeddedChunk,
} from "./app-rsc-embedded-chunks.js";
import { NAVIGATION_RUNTIME_SYMBOL_DESCRIPTION } from "../client/navigation-runtime.js";

type RscEmbedTransform = {
  flush(): string;
  finalize(): Promise<string>;
  /** Resolves when all raw bytes from the embed stream have been read. */
  getRawBuffer(): Promise<ArrayBuffer>;
};

type HtmlInsertion = string | (() => string);
type InlineCssManifest = Record<string, string>;
export type InitialNavigationCacheMetadata = {
  kind: "dynamic" | "static";
  dynamicStaleTimeSeconds?: number;
};
type InlineCssRewriteResult = {
  html: string;
  consumedPrependCss: boolean;
};

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
): string {
  return (
    "Object.assign(" +
    navigationRuntimeRscBootstrapExpression() +
    ",{params:" +
    safeJsonStringify(params) +
    ",nav:" +
    safeJsonStringify(nav) +
    (dynamicStaleTimeSeconds === undefined
      ? ""
      : ",dynamicStaleTimeSeconds:" + safeJsonStringify(dynamicStaleTimeSeconds)) +
    "})"
  );
}

function createNavigationRuntimeRscChunkScript(chunk: RscEmbeddedChunk): string {
  return navigationRuntimeRscBootstrapExpression() + ".rsc.push(" + safeJsonStringify(chunk) + ")";
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
        }) +
        ");") +
    bootstrap +
    ".done=true"
  );
}

/**
 * Fix invalid preload "as" values in RSC Flight hint lines before they reach
 * the client. React Flight emits HL hints with as="stylesheet" for CSS, but
 * the HTML spec requires as="style" for <link rel="preload">.
 */
export function fixFlightHints(text: string): string {
  return text.replace(/(\d*:HL\[.*?),"stylesheet"(\]|,)/g, '$1,"style"$2');
}

/**
 * Create a helper that progressively embeds RSC chunks as inline <script> tags.
 * The browser entry turns the embedded chunks back into Uint8Array data.
 */
export function createRscEmbedTransform(
  embedStream: ReadableStream<Uint8Array>,
  scriptNonce?: string,
  getInitialNavigationCacheMetadata?: () => InitialNavigationCacheMetadata,
): RscEmbedTransform {
  const reader = embedStream.getReader();
  let pendingChunks: RscEmbeddedChunk[] = [];
  const rawChunks: Uint8Array[] = [];
  let reading = false;

  async function pumpReader(): Promise<void> {
    if (reading) return;
    reading = true;
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        // Accumulate raw bytes BEFORE fixFlightHints so the cache stores
        // unmodified RSC data. The embed script path below applies fixes.
        rawChunks.push(result.value);
        try {
          const decoder = new TextDecoder("utf-8", { fatal: true });
          const text = decoder.decode(result.value);
          // The RSC entry already fixes HL hints at the source. Keep this second
          // pass as defense in depth for any embed stream that bypasses that
          // wrapper; the rewrite is idempotent, so double-application is safe.
          pendingChunks.push(fixFlightHints(text));
        } catch {
          pendingChunks.push([RSC_EMBEDDED_BINARY_CHUNK, bytesToBase64(result.value)]);
        }
      }
    } catch (error) {
      if (process.env.NODE_ENV !== "production") {
        console.warn("[vinext] RSC embed stream read error:", error);
      }
      throw error;
    } finally {
      reading = false;
    }
  }

  const pumpPromise = pumpReader();

  return {
    flush(): string {
      if (pendingChunks.length === 0) return "";

      const chunks = pendingChunks;
      pendingChunks = [];

      let scripts = "";
      for (const chunk of chunks) {
        scripts += createInlineScriptTag(createNavigationRuntimeRscChunkScript(chunk), scriptNonce);
      }
      return scripts;
    },

    async finalize(): Promise<string> {
      await pumpPromise;
      let scripts = this.flush();
      scripts += createInlineScriptTag(
        createNavigationRuntimeRscDoneScript(getInitialNavigationCacheMetadata?.()),
        scriptNonce,
      );
      return scripts;
    },

    async getRawBuffer(): Promise<ArrayBuffer> {
      await pumpPromise;
      const buffer = concatUint8Arrays(rawChunks);
      rawChunks.length = 0;
      return buffer.buffer;
    },
  };
}

/**
 * Fix invalid preload "as" values in server-rendered HTML.
 * React Fizz emits <link rel="preload" as="stylesheet"> for CSS, but the
 * HTML spec requires as="style" for <link rel="preload">.
 */
export function fixPreloadAs(html: string): string {
  return html.replace(/<link(?=[^>]*\srel="preload")[^>]*>/g, (tag) =>
    tag.replace(' as="stylesheet"', ' as="style"'),
  );
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

function rewriteInlineCssStylesheetLinks(
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
  injectHTML: HtmlInsertion = "",
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
  let pendingHtml = "";
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  // Computed once at transform creation: every flush is a hot path, so we
  // avoid re-running Object.keys() on the manifest per chunk. Gates both the
  // split-link boundary buffering and the inline-css link rewrite below.
  const hasInlineCssManifest =
    inlineCssManifest !== undefined && Object.keys(inlineCssManifest).length > 0;

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
  const readInsertion = (): string =>
    typeof injectHTML === "function" ? injectHTML() : injectHTML;
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
  const spliceAfterHeadOpen = (chunk: string): { chunk: string; spliced: boolean } => {
    if (preHeadInjected) return { chunk, spliced: false };
    const insertion = readPreHeadInsertion();
    if (!insertion) return { chunk, spliced: false };
    const match = HEAD_OPEN_RE.exec(chunk);
    if (!match) return { chunk, spliced: false };
    const insertAt = match.index + match[0].length;
    return {
      chunk: chunk.slice(0, insertAt) + insertion + chunk.slice(insertAt),
      spliced: true,
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

    const preparedHtml = fixPreloadAs(split.complete);
    const inlineCssResult = hasInlineCssManifest
      ? rewriteInlineCssStylesheetLinks(
          preparedHtml,
          inlineCssManifest,
          inlineCssPrependCss,
          inlineCssScriptNonce,
        )
      : { html: preparedHtml, consumedPrependCss: false };
    if (inlineCssResult.consumedPrependCss) {
      inlineCssPrependCss = "";
    }

    let working = inlineCssResult.html;
    if (!preHeadInjected) {
      const result = spliceAfterHeadOpen(working);
      if (result.spliced) {
        working = result.chunk;
        preHeadInjected = true;
      }
    }
    if (!injected) {
      const headEnd = working.indexOf("</head>");
      if (headEnd !== -1) {
        const before = working.slice(0, headEnd);
        const after = stripDocumentCloseSuffix(working.slice(headEnd));
        controller.enqueue(
          encoder.encode(before + readInlineCssPrependFallback() + readInsertion() + after),
        );
        injected = true;
        return;
      }
    }
    working = stripDocumentCloseSuffix(working);
    controller.enqueue(encoder.encode(working));
  };

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffered.push(decoder.decode(chunk, { stream: true }));

      if (timeoutId !== null) return;

      timeoutId = setTimeout(() => {
        try {
          flushBuffered(controller);

          const rscScripts = rscEmbed.flush();
          if (rscScripts) {
            controller.enqueue(encoder.encode(rscScripts));
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

      const finalScripts = await rscEmbed.finalize();
      if (finalScripts) {
        controller.enqueue(encoder.encode(finalScripts));
      }

      // Emit `</body></html>` last so the document always terminates with a
      // well-formed close, after any trailing flight chunks / preinit scripts.
      // Mirrors Next.js's `createMoveSuffixStream` behaviour (#1532).
      controller.enqueue(encoder.encode(DOCUMENT_CLOSE_SUFFIX));
    },
  });
}
