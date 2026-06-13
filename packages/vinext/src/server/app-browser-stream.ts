import type { ReactFormState } from "react-dom/client";
import {
  ensureNavigationRuntimeRscBootstrap,
  getNavigationRuntime,
  type NavigationRuntimeRscBootstrap,
  type NavigationRuntimeSnapshot,
} from "../client/navigation-runtime.js";
import { RSC_FORM_STATE_GLOBAL } from "./app-browser-hydration.js";
import { decodeRscEmbeddedChunk, type RscEmbeddedChunk } from "./app-rsc-embedded-chunks.js";

type VinextBrowserGlobals = {
  __VINEXT_RSC_CHUNKS__?: RscEmbeddedChunk[];
  __VINEXT_RSC_DONE__?: boolean;
  [RSC_FORM_STATE_GLOBAL]?: ReactFormState;
  __VINEXT_RSC_PARAMS__?: Record<string, string | string[]>;
  __VINEXT_RSC_NAV__?: NavigationRuntimeSnapshot;
};

export function getVinextBrowserGlobal(): typeof globalThis & VinextBrowserGlobals {
  return globalThis as typeof globalThis & VinextBrowserGlobals;
}

function createUnexpectedRscStreamCloseError(): Error {
  return new Error(
    "The connection to the page was unexpectedly closed, possibly due to the stop button being clicked, loss of Wi-Fi, or an unstable internet connection.",
  );
}

/**
 * Convert embedded chunks back to a ReadableStream of Uint8Array chunks.
 */
export function chunksToReadableStream(
  chunks: readonly RscEmbeddedChunk[],
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(decodeRscEmbeddedChunk(chunk));
      }
      controller.close();
    },
  });
}

function getNavigationRuntimeRscBootstrap(): NavigationRuntimeRscBootstrap | null {
  return getNavigationRuntime()?.bootstrap.rsc ?? null;
}

function observeDoneMarker(
  target: object,
  key: string,
  initialValue: boolean | undefined,
  onDone: () => void,
): void {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  if (descriptor && !descriptor.configurable) return;

  let value = initialValue;
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: descriptor?.enumerable ?? true,
    get() {
      return value;
    },
    set(nextValue: boolean | undefined) {
      value = nextValue;
      if (nextValue === true) onDone();
    },
  });
}

/**
 * Create a ReadableStream from progressively-embedded RSC chunks.
 *
 * The server pushes chunks into the typed navigation runtime via inline
 * <script> tags. We monkey-patch `push()` so new chunks stream to React
 * immediately instead of polling with setTimeout.
 */
export function createProgressiveRscStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const vinext = getVinextBrowserGlobal();
      const runtimeRsc = getNavigationRuntimeRscBootstrap();
      const initialChunks = runtimeRsc?.rsc ?? vinext.__VINEXT_RSC_CHUNKS__ ?? [];

      for (const chunk of initialChunks) {
        controller.enqueue(decodeRscEmbeddedChunk(chunk));
      }

      if (runtimeRsc?.done || vinext.__VINEXT_RSC_DONE__) {
        controller.close();
        return;
      }

      let closed = false;
      let cancelDocumentCompletionCheck: (() => void) | undefined;
      const cancelPendingDocumentCompletionCheck = () => {
        const cancel = cancelDocumentCompletionCheck;
        cancelDocumentCompletionCheck = undefined;
        cancel?.();
      };
      const closeOnce = () => {
        if (!closed) {
          closed = true;
          cancelPendingDocumentCompletionCheck();
          controller.close();
        }
      };
      const errorOnce = () => {
        if (!closed) {
          closed = true;
          cancelPendingDocumentCompletionCheck();
          controller.error(createUnexpectedRscStreamCloseError());
        }
      };

      const liveRuntimeRsc =
        getNavigationRuntime() === null ? null : ensureNavigationRuntimeRscBootstrap();
      const arr = liveRuntimeRsc?.rsc ?? (vinext.__VINEXT_RSC_CHUNKS__ ??= []);
      // Capture the bootstrap object before it can be cleared. Inline done
      // scripts mutate this same object, and clearing happens only after the
      // stream has already been consumed or closed.
      if (liveRuntimeRsc) {
        observeDoneMarker(liveRuntimeRsc, "done", liveRuntimeRsc.done, closeOnce);
      } else {
        observeDoneMarker(vinext, "__VINEXT_RSC_DONE__", vinext.__VINEXT_RSC_DONE__, closeOnce);
      }
      arr.push = function (...chunks: RscEmbeddedChunk[]): number {
        const length = Array.prototype.push.apply(this, chunks);

        if (closed) return length;

        for (const chunk of chunks) {
          controller.enqueue(decodeRscEmbeddedChunk(chunk));
        }

        if (liveRuntimeRsc?.done || vinext.__VINEXT_RSC_DONE__) {
          closeOnce();
        }

        return length;
      };

      if (typeof document !== "undefined") {
        if (document.readyState === "loading") {
          document.addEventListener("DOMContentLoaded", errorOnce);
          cancelDocumentCompletionCheck = () =>
            document.removeEventListener("DOMContentLoaded", errorOnce);
        } else {
          const timeoutId = setTimeout(errorOnce);
          cancelDocumentCompletionCheck = () => clearTimeout(timeoutId);
        }
      }
    },
  });
}
