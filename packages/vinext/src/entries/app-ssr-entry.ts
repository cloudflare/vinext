/**
 * Generate the virtual SSR entry module.
 *
 * This runs in the `ssr` Vite environment. It receives an RSC stream,
 * deserializes it to a React tree, and renders to HTML.
 *
 * When `hasPagesDir` is true (hybrid App + Pages Router project), the SSR
 * entry also re-exports `pageRoutes` from `virtual:vinext-server-entry` so
 * that the Cloudflare Workers RSC bundle can access Pages Router route
 * metadata (including `getStaticPaths`) via `import("./ssr/index.js")`.
 */
export function generateSsrEntry(hasPagesDir = false): string {
  return `
import { createFromReadableStream } from "@vitejs/plugin-rsc/ssr";
import { renderToReadableStream, renderToStaticMarkup } from "react-dom/server.edge";
import { setNavigationContext, ServerInsertedHTMLContext } from "next/navigation";
import { runWithNavigationContext as _runWithNavCtx } from "vinext/navigation-state";
import { safeJsonStringify } from "vinext/html";
import { createElement as _ssrCE } from "react";
import * as _clientRefs from "virtual:vite-rsc/client-references";

let _clientRefsPreloaded = false;

/**
 * Collect all chunks from a ReadableStream into an array of text strings.
 * Used to capture the RSC payload for embedding in HTML.
 * The RSC flight protocol is text-based (line-delimited key:value pairs),
 * so we decode to text strings instead of byte arrays — this is dramatically
 * more compact when JSON-serialized into inline <script> tags.
 */
async function collectStreamChunks(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    // Decode Uint8Array to text string for compact JSON serialization
    chunks.push(decoder.decode(value, { stream: true }));
  }
  return chunks;
}

// React 19 dev-mode workaround (see VinextFlightRoot in handleSsr):
//
// In dev, Flight error decoding in react-server-dom-webpack/client.edge
// can hit resolveErrorDev() which (via React's dev error stack capture)
// expects a non-null hooks dispatcher.
//
// Vinext previously called createFromReadableStream() outside of any React render.
// When an RSC stream contains an error, dev-mode decoding could crash with:
//   - "Invalid hook call"
//   - "Cannot read properties of null (reading 'useContext')"
//
// Fix: call createFromReadableStream() lazily inside a React component render.
// This mirrors Next.js behavior and ensures the dispatcher is set.

/**
 * Create a TransformStream that appends RSC chunks as inline <script> tags
 * to the HTML stream. This allows progressive hydration — the browser receives
 * RSC data incrementally as Suspense boundaries resolve, rather than waiting
 * for the entire RSC payload before hydration can begin.
 *
 * Each chunk is written as:
 *   <script>self.__VINEXT_RSC_CHUNKS__=self.__VINEXT_RSC_CHUNKS__||[];self.__VINEXT_RSC_CHUNKS__.push("...")</script>
 *
 * Chunks are embedded as text strings (not byte arrays) since the RSC flight
 * protocol is text-based. The browser entry encodes them back to Uint8Array.
 * This is ~3x more compact than the previous byte-array format.
 */
function createRscEmbedTransform(embedStream) {
  const reader = embedStream.getReader();
  const _decoder = new TextDecoder();
  let done = false;
  let pendingChunks = [];
  let reading = false;

  // Start reading RSC chunks in the background, accumulating them as text strings.
  // The RSC flight protocol is text-based, so decoding to strings and embedding
  // as JSON strings is ~3x more compact than the byte-array format.
  //
  // Note: Flight HL hint "stylesheet" → "style" rewriting is handled upstream
  // in the renderToReadableStream wrapper (app-rsc-entry.ts), so the stream
  // arriving here is already clean.
  async function pumpReader() {
    if (reading) return;
    reading = true;
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) {
          done = true;
          break;
        }
        const text = _decoder.decode(result.value, { stream: true });
        pendingChunks.push(text);
      }
    } catch (err) {
      if (process.env.NODE_ENV !== "production") {
        console.warn("[vinext] RSC embed stream read error:", err);
      }
      done = true;
    }
    reading = false;
  }

  // Fire off the background reader immediately
  const pumpPromise = pumpReader();

  return {
    /**
     * Flush any accumulated RSC chunks as <script> tags.
     * Called after each HTML chunk is enqueued.
     */
    flush() {
      if (pendingChunks.length === 0) return "";
      const chunks = pendingChunks;
      pendingChunks = [];
      let scripts = "";
      for (const chunk of chunks) {
        scripts += "<script>self.__VINEXT_RSC_CHUNKS__=self.__VINEXT_RSC_CHUNKS__||[];self.__VINEXT_RSC_CHUNKS__.push(" + safeJsonStringify(chunk) + ")</script>";
      }
      return scripts;
    },

    /**
     * Wait for the RSC stream to fully complete and return any final
     * script tags plus the closing signal.
     */
    async finalize() {
      await pumpPromise;
      let scripts = this.flush();
      // Signal that all RSC chunks have been sent.
      // Params are already embedded in <head> — no need to include here.
      scripts += "<script>self.__VINEXT_RSC_DONE__=true</script>";
      return scripts;
    },
  };
}

/**
 * Render the RSC stream to HTML.
 *
 * @param rscStream - The RSC payload stream from the RSC environment
 * @param navContext - Navigation context for client component SSR hooks.
 *   "use client" components like those using usePathname() need the current
 *   request URL during SSR, and they run in this SSR environment (separate
 *   from the RSC environment where the context was originally set).
 * @param fontData - Font links and styles collected from the RSC environment.
 *   Fonts are loaded during RSC rendering (when layout calls Geist() etc.),
 *   and the data needs to be passed to SSR since they're separate module instances.
 */
export async function handleSsr(rscStream, navContext, fontData) {
  // Eagerly preload all client reference modules before SSR rendering.
  // On the first request after server start, client component modules are
  // loaded lazily via async import(). Without this preload, React's
  // renderToReadableStream rejects because the shell can't resolve client
  // components synchronously (there is no Suspense boundary wrapping the
  // root). The memoized require cache ensures this is only async on the
  // very first call; subsequent requests resolve from cache immediately.
  // See: https://github.com/cloudflare/vinext/issues/256
  // _clientRefs.default is the default export from the virtual:vite-rsc/client-references
  // namespace import — a map of client component IDs to their async import functions.
  if (!_clientRefsPreloaded && _clientRefs.default && globalThis.__vite_rsc_client_require__) {
    await Promise.all(
      Object.keys(_clientRefs.default).map((id) =>
        globalThis.__vite_rsc_client_require__(id).catch((err) => {
          if (process.env.NODE_ENV !== "production") {
            console.warn("[vinext] failed to preload client ref:", id, err);
          }
        })
      )
    );
    _clientRefsPreloaded = true;
  }

  // Wrap in a navigation ALS scope for per-request isolation in the SSR
  // environment. The SSR environment has separate module instances from RSC,
  // so it needs its own ALS scope.
  return _runWithNavCtx(async () => {
  // Set navigation context so hooks like usePathname() work during SSR
  // of "use client" components
  if (navContext) {
    setNavigationContext(navContext);
  }

  // Clear any stale callbacks from previous requests
  const { clearServerInsertedHTML, flushServerInsertedHTML, useServerInsertedHTML: _addInsertedHTML } = await import("next/navigation");
  clearServerInsertedHTML();

  try {
    // Tee the RSC stream - one for SSR rendering, one for embedding in HTML.
    // This ensures the browser uses the SAME RSC payload for hydration that
    // was used to generate the HTML, avoiding hydration mismatches (React #418).
    const [ssrStream, embedStream] = rscStream.tee();

    // Create the progressive RSC embed helper — it reads the embed stream
    // in the background and provides script tags to inject into the HTML stream.
    const rscEmbed = createRscEmbedTransform(embedStream);

    // Deserialize RSC stream back to React VDOM.
    // IMPORTANT: Do NOT await this — createFromReadableStream returns a thenable
    // that React's renderToReadableStream can consume progressively. By passing
    // the unresolved thenable, React will render Suspense fallbacks (loading.tsx)
    // immediately in the HTML shell, then stream in resolved content as RSC
    // chunks arrive. Awaiting here would block until all async server components
    // complete, collapsing the streaming behavior.
    // Lazily create the Flight root inside render so React's hook dispatcher is set
    // (avoids React 19 dev-mode resolveErrorDev() crash). VinextFlightRoot returns
    // a thenable (not a ReactNode), which React 19 consumes via its internal
    // thenable-as-child suspend/resume behavior. This matches Next.js's approach.
    let flightRoot;
    function VinextFlightRoot() {
      if (!flightRoot) {
        flightRoot = createFromReadableStream(ssrStream);
      }
      return flightRoot;
    }
    const root = _ssrCE(VinextFlightRoot);

    // Wrap with ServerInsertedHTMLContext.Provider so libraries that use
    // useContext(ServerInsertedHTMLContext) (Apollo Client, styled-components,
    // etc.) get a working callback registration function during SSR.
    // The provider value is useServerInsertedHTML — same function that direct
    // callers use — so both paths push to the same ALS-backed callback array.
    const ssrRoot = ServerInsertedHTMLContext
      ? _ssrCE(ServerInsertedHTMLContext.Provider, { value: _addInsertedHTML }, root)
      : root;

    // Get the bootstrap script content for the browser entry
    const bootstrapScriptContent =
      await import.meta.viteRsc.loadBootstrapScriptContent("index");

    // djb2 hash for digest generation in the SSR environment.
    // Matches the RSC environment's __errorDigest function.
    function ssrErrorDigest(str) {
      let hash = 5381;
      for (let i = str.length - 1; i >= 0; i--) {
        hash = (hash * 33) ^ str.charCodeAt(i);
      }
      return (hash >>> 0).toString();
    }

    // Render HTML (streaming SSR)
    // useServerInsertedHTML callbacks are registered during this render.
    // The onError callback preserves the digest for Next.js navigation errors
    // (redirect, notFound, forbidden, unauthorized) thrown inside Suspense
    // boundaries during RSC streaming. Without this, React's default onError
    // returns undefined and the digest is lost in the $RX() call, preventing
    // client-side error boundaries from identifying the error type.
    // In production, non-navigation errors also get a digest hash so they
    // can be correlated with server logs without leaking details to clients.
    const htmlStream = await renderToReadableStream(ssrRoot, {
      bootstrapScriptContent,
      onError(error) {
        if (error && typeof error === "object" && "digest" in error) {
          return String(error.digest);
        }
        // In production, generate a digest hash for non-navigation errors
        if (process.env.NODE_ENV === "production" && error) {
          const msg = error instanceof Error ? error.message : String(error);
          const stack = error instanceof Error ? (error.stack || "") : "";
          return ssrErrorDigest(msg + stack);
        }
        return undefined;
      },
    });

    // Flush useServerInsertedHTML callbacks (CSS-in-JS style injection)
    const insertedElements = flushServerInsertedHTML();

    // Render the inserted elements to HTML strings
    const { Fragment } = await import("react");
    let insertedHTML = "";
    for (const el of insertedElements) {
      try {
        insertedHTML += renderToStaticMarkup(_ssrCE(Fragment, null, el));
      } catch {
        // Skip elements that can't be rendered
      }
    }

    // Escape HTML attribute values (defense-in-depth for font URLs/types).
    function _escAttr(s) { return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;"); }

    // Build font HTML from data passed from RSC environment
    // (Fonts are loaded during RSC rendering, and RSC/SSR are separate module instances)
    let fontHTML = "";
    if (fontData) {
      if (fontData.links && fontData.links.length > 0) {
        for (const url of fontData.links) {
          fontHTML += '<link rel="stylesheet" href="' + _escAttr(url) + '" />\\n';
        }
      }
      // Emit <link rel="preload"> for local font files
      if (fontData.preloads && fontData.preloads.length > 0) {
        for (const preload of fontData.preloads) {
          fontHTML += '<link rel="preload" href="' + _escAttr(preload.href) + '" as="font" type="' + _escAttr(preload.type) + '" crossorigin />\\n';
        }
      }
      if (fontData.styles && fontData.styles.length > 0) {
        fontHTML += '<style data-vinext-fonts>' + fontData.styles.join("\\n") + '</style>\\n';
      }
    }

    // Extract client entry module URL from bootstrapScriptContent to emit
    // a <link rel="modulepreload"> hint. The RSC plugin formats bootstrap
    // content as: import("URL") — we extract the URL so the browser can
    // speculatively fetch and parse the JS module while still processing
    // the HTML body, instead of waiting until it reaches the inline script.
    let modulePreloadHTML = "";
    if (bootstrapScriptContent) {
      const m = bootstrapScriptContent.match(/import\\("([^"]+)"\\)/);
      if (m && m[1]) {
        modulePreloadHTML = '<link rel="modulepreload" href="' + _escAttr(m[1]) + '" />\\n';
      }
    }

    // Head-injected HTML: server-inserted HTML, font HTML, route params,
    // and modulepreload hints.
    // RSC payload is now embedded progressively via script tags in the body stream.
    // Params are embedded eagerly in <head> so they're available before client
    // hydration starts, avoiding the need for polling on the client.
    const paramsScript = '<script>self.__VINEXT_RSC_PARAMS__=' + safeJsonStringify(navContext?.params || {}) + '</script>';
    // Embed the initial navigation context (pathname + searchParams) so the
    // browser useSyncExternalStore getServerSnapshot can return the correct
    // value during hydration. Without this, getServerSnapshot returns "/" and
    // React detects a mismatch against the SSR-rendered HTML.
     // Serialise searchParams as an array of [key, value] pairs to preserve
     // duplicate keys (e.g. ?tag=a&tag=b). Object.fromEntries() would keep
     // only the last value, causing a hydration mismatch for multi-value params.
     const __navPayload = { pathname: navContext?.pathname ?? '/', searchParams: navContext?.searchParams ? [...navContext.searchParams.entries()] : [] };
    const navScript = '<script>self.__VINEXT_RSC_NAV__=' + safeJsonStringify(__navPayload) + '</script>';
    const injectHTML = paramsScript + navScript + modulePreloadHTML + insertedHTML + fontHTML;

    // Inject the collected HTML before </head> and progressively embed RSC
    // chunks as script tags throughout the HTML body stream.
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let injected = false;

    // Fix invalid preload "as" values in server-rendered HTML.
    // React Fizz emits <link rel="preload" as="stylesheet"> for CSS,
    // but the HTML spec requires as="style" for <link rel="preload">.
    // Note: Flight HL hints are fixed upstream in the renderToReadableStream
    // wrapper (app-rsc-entry.ts); this only handles the Fizz HTML stream.
    // See: https://html.spec.whatwg.org/multipage/links.html#link-type-preload
    function fixPreloadAs(html) {
      // Match <link ...rel="preload"... as="stylesheet"...> in any attribute order
      return html.replace(/<link(?=[^>]*\\srel="preload")[^>]*>/g, function(tag) {
        return tag.replace(' as="stylesheet"', ' as="style"');
      });
    }

    // Tick-buffered RSC script injection.
    //
    // React's renderToReadableStream (Fizz) flushes chunks synchronously
    // within one microtask — all chunks from a single flushCompletedQueues
    // call arrive in the same macrotask. We buffer HTML chunks as they
    // arrive, then use setTimeout(0) to defer emitting them plus any
    // accumulated RSC scripts to the next macrotask. This guarantees we
    // never inject <script> tags between partial HTML chunks (which would
    // corrupt split elements like "<linearGradi" + "ent>"), while still
    // delivering RSC data progressively as Suspense boundaries resolve.
    //
    // Reference: rsc-html-stream by Devon Govett (credited by Next.js)
    // https://github.com/devongovett/rsc-html-stream
    let buffered = [];
    let timeoutId = null;

    const transform = new TransformStream({
      transform(chunk, controller) {
        const text = decoder.decode(chunk, { stream: true });
        const fixed = fixPreloadAs(text);
        buffered.push(fixed);

        if (timeoutId !== null) return;

        timeoutId = setTimeout(() => {
          // Flush all buffered HTML chunks from this React flush cycle
          for (const buf of buffered) {
            if (!injected) {
              const headEnd = buf.indexOf("</head>");
              if (headEnd !== -1) {
                const before = buf.slice(0, headEnd);
                const after = buf.slice(headEnd);
                controller.enqueue(encoder.encode(before + injectHTML + after));
                injected = true;
                continue;
              }
            }
            controller.enqueue(encoder.encode(buf));
          }
          buffered = [];

          // Now safe to inject any accumulated RSC scripts — we're between
          // React flush cycles, so no partial HTML chunks can follow until
          // the next macrotask.
          const rscScripts = rscEmbed.flush();
          if (rscScripts) {
            controller.enqueue(encoder.encode(rscScripts));
          }

          timeoutId = null;
        }, 0);
      },
      async flush(controller) {
        // Cancel any pending setTimeout callback — flush() drains
        // everything itself, so the callback would be a no-op but
        // cancelling makes the code obviously correct.
        if (timeoutId !== null) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }

        // Flush any remaining buffered HTML chunks
        for (const buf of buffered) {
          if (!injected) {
            const headEnd = buf.indexOf("</head>");
            if (headEnd !== -1) {
              const before = buf.slice(0, headEnd);
              const after = buf.slice(headEnd);
              controller.enqueue(encoder.encode(before + injectHTML + after));
              injected = true;
              continue;
            }
          }
          controller.enqueue(encoder.encode(buf));
        }
        buffered = [];

        if (!injected && injectHTML) {
          controller.enqueue(encoder.encode(injectHTML));
        }
        // Finalize: wait for the RSC stream to complete and emit remaining
        // chunks plus the __VINEXT_RSC_DONE__ signal.
        const finalScripts = await rscEmbed.finalize();
        if (finalScripts) {
          controller.enqueue(encoder.encode(finalScripts));
        }
      },
    });

    return htmlStream.pipeThrough(transform);
  } finally {
    // Clean up so we don't leak context between requests
    setNavigationContext(null);
    clearServerInsertedHTML();
  }
  }); // end _runWithNavCtx
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("//")) {
      return new Response("404 Not Found", { status: 404 });
    }
    const rscModule = await import.meta.viteRsc.loadModule("rsc", "index");
    const result = await rscModule.default(request);
    if (result instanceof Response) {
      return result;
    }
    if (result === null || result === undefined) {
      return new Response("Not Found", { status: 404 });
    }
    return new Response(String(result), { status: 200 });
  },
};
${
  hasPagesDir
    ? `
// Re-export pageRoutes and renderPage from the Pages Router server entry so
// that the Cloudflare Workers RSC bundle can access Pages Router route metadata
// (including getStaticPaths) via import("./ssr/index.js").pageRoutes, and can
// delegate unmatched App Router requests to renderPage for hybrid builds.
export { pageRoutes, renderPage } from "virtual:vinext-server-entry";
`
    : ""
}`;
}
