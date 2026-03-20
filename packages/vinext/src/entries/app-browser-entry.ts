/**
 * Generate the virtual browser entry module.
 *
 * This runs in the client (browser). It hydrates the page from the
 * embedded RSC payload and handles client-side navigation by re-fetching
 * RSC streams.
 */
export function generateBrowserEntry(): string {
  return `
import {
  createFromReadableStream,
  createFromFetch,
  setServerCallback,
  encodeReply,
  createTemporaryReferenceSet,
} from "@vitejs/plugin-rsc/browser";
import { hydrateRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { setClientParams, setNavigationContext, toRscUrl, getPrefetchCache, getPrefetchedUrls, PREFETCH_CACHE_TTL } from "next/navigation";

let reactRoot;

/**
 * Convert the embedded RSC chunks back to a ReadableStream.
 * Each chunk is a text string that needs to be encoded back to Uint8Array.
 */
function chunksToReadableStream(chunks) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    }
  });
}

/**
 * Create a ReadableStream from progressively-embedded RSC chunks.
 * The server injects RSC data as <script> tags that push to
 * self.__VINEXT_RSC_CHUNKS__ throughout the HTML stream, and sets
 * self.__VINEXT_RSC_DONE__ = true when complete.
 *
 * Instead of polling with setTimeout, we monkey-patch the array's
 * push() method so new chunks are delivered immediately when the
 * server's <script> tags execute. This eliminates unnecessary
 * wakeups and reduces latency — same pattern Next.js uses with
 * __next_f. The stream closes on DOMContentLoaded (when all
 * server-injected scripts have executed) or when __VINEXT_RSC_DONE__
 * is set, whichever comes first.
 */
function createProgressiveRscStream() {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      const chunks = self.__VINEXT_RSC_CHUNKS__ || [];

      // Deliver any chunks that arrived before this code ran
      // (from <script> tags that executed before the browser entry loaded)
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }

      // If the stream is already complete, close immediately
      if (self.__VINEXT_RSC_DONE__) {
        controller.close();
        return;
      }

      // Monkey-patch push() so future chunks stream in immediately
      // when the server's <script> tags execute
      let closed = false;
      function closeOnce() {
        if (!closed) {
          closed = true;
          controller.close();
        }
      }

      const arr = self.__VINEXT_RSC_CHUNKS__ = self.__VINEXT_RSC_CHUNKS__ || [];
      arr.push = function(chunk) {
        Array.prototype.push.call(this, chunk);
        if (!closed) {
          controller.enqueue(encoder.encode(chunk));
          if (self.__VINEXT_RSC_DONE__) {
            closeOnce();
          }
        }
        return this.length;
      };

      // Safety net: if the server crashes mid-stream and __VINEXT_RSC_DONE__
      // never arrives, close the stream when all server-injected scripts
      // have executed (DOMContentLoaded). Without this, a truncated response
      // leaves the ReadableStream open forever, hanging hydration.
      if (typeof document !== "undefined") {
        if (document.readyState === "loading") {
          document.addEventListener("DOMContentLoaded", closeOnce);
        } else {
          // Document already loaded — close immediately if not already done
          closeOnce();
        }
      }
    }
  });
}

// Register the server action callback — React calls this internally
// when a "use server" function is invoked from client code.
setServerCallback(async (id, args) => {
  const temporaryReferences = createTemporaryReferenceSet();
  const body = await encodeReply(args, { temporaryReferences });

  const fetchResponse = await fetch(toRscUrl(window.location.pathname + window.location.search), {
    method: "POST",
    headers: { "x-rsc-action": id },
    body,
  });

  // Check for redirect signal from server action that called redirect()
  const actionRedirect = fetchResponse.headers.get("x-action-redirect");
  if (actionRedirect) {
    // External URLs (different origin) need a hard redirect — client-side
    // RSC navigation only works for same-origin paths.
    try {
      const redirectUrl = new URL(actionRedirect, window.location.origin);
      if (redirectUrl.origin !== window.location.origin) {
        window.location.href = actionRedirect;
        return undefined;
      }
    } catch {
      // If URL parsing fails, fall through to client-side navigation
    }

    // Navigate to the redirect target using client-side navigation
    const redirectType = fetchResponse.headers.get("x-action-redirect-type") || "replace";
    if (redirectType === "push") {
      window.history.pushState(null, "", actionRedirect);
    } else {
      window.history.replaceState(null, "", actionRedirect);
    }
    // Trigger RSC navigation to the redirect target
    if (typeof window.__VINEXT_RSC_NAVIGATE__ === "function") {
      window.__VINEXT_RSC_NAVIGATE__(actionRedirect);
    }
    return undefined;
  }

  const result = await createFromFetch(Promise.resolve(fetchResponse), { temporaryReferences });

  // The RSC response for actions contains { root, returnValue }.
  // Re-render the page with the updated tree.
  if (result && typeof result === "object" && "root" in result) {
    reactRoot.render(result.root);
    // Return the action's return value to the caller
    if (result.returnValue) {
      if (!result.returnValue.ok) throw result.returnValue.data;
      return result.returnValue.data;
    }
    return undefined;
  }

  // Fallback: render the entire result as the tree
  reactRoot.render(result);
  return result;
});

async function main() {
  let rscStream;

  // Use embedded RSC data for initial hydration if available.
  // This ensures we use the SAME RSC payload that generated the HTML,
  // avoiding hydration mismatches (React error #418).
  //
  // The server embeds RSC chunks progressively as <script> tags that push
  // to self.__VINEXT_RSC_CHUNKS__. When complete, self.__VINEXT_RSC_DONE__
  // is set and self.__VINEXT_RSC_PARAMS__ contains route params.
  // For backwards compat, also check the legacy self.__VINEXT_RSC__ format.
  if (self.__VINEXT_RSC_CHUNKS__ || self.__VINEXT_RSC_DONE__ || self.__VINEXT_RSC__) {
    if (self.__VINEXT_RSC__) {
      // Legacy format: single object with all chunks
      const embedData = self.__VINEXT_RSC__;
      delete self.__VINEXT_RSC__;
      if (embedData.params) {
        setClientParams(embedData.params);
      }
      // Legacy format may include nav context for hydration snapshot consistency.
      if (embedData.nav) {
        setNavigationContext({ pathname: embedData.nav.pathname, searchParams: new URLSearchParams(embedData.nav.searchParams || {}), params: embedData.params || {} });
      }
      rscStream = chunksToReadableStream(embedData.rsc);
    } else {
      // Progressive format: chunks arrive incrementally via script tags.
      // Params are embedded in <head> so they're always available by this point.
      if (self.__VINEXT_RSC_PARAMS__) {
        setClientParams(self.__VINEXT_RSC_PARAMS__);
      }
      // Restore the server navigation context so useSyncExternalStore getServerSnapshot
      // matches what was rendered on the server, preventing hydration mismatches.
      if (self.__VINEXT_RSC_NAV__) {
        const __nav = self.__VINEXT_RSC_NAV__;
        setNavigationContext({ pathname: __nav.pathname, searchParams: new URLSearchParams(__nav.searchParams), params: self.__VINEXT_RSC_PARAMS__ || {} });
      }
      rscStream = createProgressiveRscStream();
    }
  } else {
    // Fallback: fetch fresh RSC (shouldn't happen on initial page load)
    const rscResponse = await fetch(toRscUrl(window.location.pathname + window.location.search));

    // Hydrate useParams() with route params from the server before React hydration
    const paramsHeader = rscResponse.headers.get("X-Vinext-Params");
    if (paramsHeader) {
      try { setClientParams(JSON.parse(paramsHeader)); } catch (_e) { /* ignore */ }
    }
    // Set nav context from current URL for hydration snapshot consistency.
    setNavigationContext({ pathname: window.location.pathname, searchParams: new URLSearchParams(window.location.search), params: self.__VINEXT_RSC_PARAMS__ || {} });

    rscStream = rscResponse.body;
  }

  const root = await createFromReadableStream(rscStream);

  // Hydrate the document
  // In development, suppress Vite's error overlay for errors caught by React error
  // boundaries. Without this, React re-throws caught errors to the global handler,
  // which triggers Vite's overlay even though the error was handled by an error.tsx.
  // In production, preserve React's default onCaughtError (console.error) so
  // boundary-caught errors remain visible to error monitoring.
  reactRoot = hydrateRoot(document, root, import.meta.env.DEV ? {
    onCaughtError: function() {},
  } : undefined);

  // Store for client-side navigation
  window.__VINEXT_RSC_ROOT__ = reactRoot;

  // Client-side navigation handler
  // Checks the prefetch cache (populated by <Link> IntersectionObserver and
  // router.prefetch()) before making a network request. This makes navigation
  // near-instant for prefetched routes.
  window.__VINEXT_RSC_NAVIGATE__ = async function navigateRsc(href, __redirectDepth) {
    if ((__redirectDepth || 0) > 10) {
      console.error("[vinext] Too many RSC redirects — aborting navigation to prevent infinite loop.");
      window.location.href = href;
      return;
    }
    try {
      const url = new URL(href, window.location.origin);
      const rscUrl = toRscUrl(url.pathname + url.search);

      // Check the in-memory prefetch cache first
      let navResponse;
      const prefetchCache = getPrefetchCache();
      const cached = prefetchCache.get(rscUrl);
      if (cached && (Date.now() - cached.timestamp) < PREFETCH_CACHE_TTL) {
        navResponse = cached.response;
        prefetchCache.delete(rscUrl); // Consume the cached entry (one-time use)
        getPrefetchedUrls().delete(rscUrl); // Allow re-prefetch when link is visible again
      } else if (cached) {
        prefetchCache.delete(rscUrl); // Expired, clean up
        getPrefetchedUrls().delete(rscUrl);
      }

      // Fallback to network fetch if not in cache
      if (!navResponse) {
        navResponse = await fetch(rscUrl, {
          headers: { Accept: "text/x-component" },
          credentials: "include",
        });
      }

      // Detect if fetch followed a redirect: compare the final response URL to
      // what we requested. If they differ, the server issued a 3xx — push the
      // canonical destination URL into history before rendering.
      const __finalUrl = new URL(navResponse.url);
      const __requestedUrl = new URL(rscUrl, window.location.origin);
      if (__finalUrl.pathname !== __requestedUrl.pathname) {
        // Strip .rsc suffix from the final URL to get the page path for history.
        // Use replaceState instead of pushState: the caller (navigateImpl) already
        // pushed the pre-redirect URL; replacing it avoids a stale history entry.
        const __destPath = __finalUrl.pathname.replace(/\\.rsc$/, "") + __finalUrl.search;
        window.history.replaceState(null, "", __destPath);
        return window.__VINEXT_RSC_NAVIGATE__(__destPath, (__redirectDepth || 0) + 1);
      }

      // Update useParams() with route params from the server before re-rendering
      const navParamsHeader = navResponse.headers.get("X-Vinext-Params");
      if (navParamsHeader) {
        try { setClientParams(JSON.parse(navParamsHeader)); } catch (_e) { /* ignore */ }
      } else {
        setClientParams({});
      }

      const rscPayload = await createFromFetch(Promise.resolve(navResponse));
      // Use flushSync to guarantee React commits the new tree to the DOM
      // synchronously before this function returns. Callers scroll to top
      // after awaiting, so the new content must be painted first.
      flushSync(function () { reactRoot.render(rscPayload); });
    } catch (err) {
      console.error("[vinext] RSC navigation error:", err);
      // Fallback to full page load
      window.location.href = href;
    }
  };

  // Handle popstate (browser back/forward)
  // Store the navigation promise on a well-known property so that
  // restoreScrollPosition (in navigation.ts) can await it before scrolling.
  // This prevents a flash where the old content is visible at the restored
  // scroll position before the new RSC payload has rendered.
  window.addEventListener("popstate", () => {
    const p = window.__VINEXT_RSC_NAVIGATE__(window.location.href);
    window.__VINEXT_RSC_PENDING__ = p;
    p.finally(() => {
      // Clear once settled so stale promises aren't awaited later
      if (window.__VINEXT_RSC_PENDING__ === p) {
        window.__VINEXT_RSC_PENDING__ = null;
      }
    });
  });

  // HMR: re-render on server module updates
  if (import.meta.hot) {
    import.meta.hot.on("rsc:update", async () => {
      try {
        const rscPayload = await createFromFetch(
          fetch(toRscUrl(window.location.pathname + window.location.search))
        );
        reactRoot.render(rscPayload);
      } catch (err) {
        console.error("[vinext] RSC HMR error:", err);
      }
    });
  }
}

main();
`;
}
