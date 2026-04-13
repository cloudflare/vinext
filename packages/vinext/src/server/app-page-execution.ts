import type { LayoutFlags } from "./app-elements.js";

export type { LayoutFlags };

export type AppPageSpecialError =
  | { kind: "redirect"; location: string; statusCode: number }
  | { kind: "http-access-fallback"; statusCode: number };

export type AppPageFontPreload = {
  href: string;
  type: string;
};

export type AppPageRscStreamCapture = {
  capturedRscDataPromise: Promise<ArrayBuffer> | null;
  responseStream: ReadableStream<Uint8Array>;
};

export type BuildAppPageSpecialErrorResponseOptions = {
  clearRequestContext: () => void;
  renderFallbackPage?: (statusCode: number) => Promise<Response | null>;
  requestUrl: string;
  specialError: AppPageSpecialError;
};

export type ProbeAppPageLayoutsResult = {
  response: Response | null;
  layoutFlags: LayoutFlags;
};

export type LayoutClassificationOptions = {
  /** Build-time classifications from segment config or module graph, keyed by layout index. */
  buildTimeClassifications?: ReadonlyMap<number, "static" | "dynamic"> | null;
  /** Maps layout index to its layout ID (e.g. "layout:/blog"). */
  getLayoutId: (layoutIndex: number) => string;
  /** Runs a function with isolated dynamic usage tracking per layout. */
  runWithIsolatedDynamicScope: <T>(fn: () => T) => Promise<{ result: T; dynamicDetected: boolean }>;
};

export type ProbeAppPageLayoutsOptions = {
  layoutCount: number;
  onLayoutError: (error: unknown, layoutIndex: number) => Promise<Response | null>;
  probeLayoutAt: (layoutIndex: number) => unknown;
  runWithSuppressedHookWarning<T>(probe: () => Promise<T>): Promise<T>;
  /** When provided, enables per-layout static/dynamic classification. */
  classification?: LayoutClassificationOptions | null;
};

export type ProbeAppPageComponentOptions = {
  awaitAsyncResult: boolean;
  onError: (error: unknown) => Promise<Response | null>;
  probePage: () => unknown;
  runWithSuppressedHookWarning<T>(probe: () => Promise<T>): Promise<T>;
};

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return Boolean(
    value &&
    (typeof value === "object" || typeof value === "function") &&
    "then" in value &&
    typeof value.then === "function",
  );
}

function getAppPageStatusText(statusCode: number): string {
  return statusCode === 403 ? "Forbidden" : statusCode === 401 ? "Unauthorized" : "Not Found";
}

export function resolveAppPageSpecialError(error: unknown): AppPageSpecialError | null {
  if (!(error && typeof error === "object" && "digest" in error)) {
    return null;
  }

  const digest = String(error.digest);

  if (digest.startsWith("NEXT_REDIRECT;")) {
    const parts = digest.split(";");
    return {
      kind: "redirect",
      location: decodeURIComponent(parts[2]),
      statusCode: parts[3] ? parseInt(parts[3], 10) : 307,
    };
  }

  if (digest === "NEXT_NOT_FOUND" || digest.startsWith("NEXT_HTTP_ERROR_FALLBACK;")) {
    return {
      kind: "http-access-fallback",
      statusCode: digest === "NEXT_NOT_FOUND" ? 404 : parseInt(digest.split(";")[1], 10),
    };
  }

  return null;
}

export async function buildAppPageSpecialErrorResponse(
  options: BuildAppPageSpecialErrorResponseOptions,
): Promise<Response> {
  if (options.specialError.kind === "redirect") {
    options.clearRequestContext();
    return Response.redirect(
      new URL(options.specialError.location, options.requestUrl),
      options.specialError.statusCode,
    );
  }

  if (options.renderFallbackPage) {
    const fallbackResponse = await options.renderFallbackPage(options.specialError.statusCode);
    if (fallbackResponse) {
      return fallbackResponse;
    }
  }

  options.clearRequestContext();
  return new Response(getAppPageStatusText(options.specialError.statusCode), {
    status: options.specialError.statusCode,
  });
}

export async function probeAppPageLayouts(
  options: ProbeAppPageLayoutsOptions,
): Promise<ProbeAppPageLayoutsResult> {
  const layoutFlags: Record<string, "s" | "d"> = {};
  const cls = options.classification ?? null;

  const response = await options.runWithSuppressedHookWarning(async () => {
    for (let layoutIndex = options.layoutCount - 1; layoutIndex >= 0; layoutIndex--) {
      const buildTimeResult = cls?.buildTimeClassifications?.get(layoutIndex);

      if (cls && buildTimeResult) {
        // Build-time classified (Layer 1 or Layer 2): skip dynamic isolation,
        // but still probe for special errors (redirects, not-found).
        layoutFlags[cls.getLayoutId(layoutIndex)] = buildTimeResult === "static" ? "s" : "d";
        const errorResponse = await probeLayoutForErrors(options, layoutIndex);
        if (errorResponse) return errorResponse;
        continue;
      }

      if (cls) {
        // Layer 3: probe with isolated dynamic scope to detect per-layout
        // dynamic API usage (headers(), cookies(), connection(), etc.)
        try {
          const { dynamicDetected } = await cls.runWithIsolatedDynamicScope(() =>
            options.probeLayoutAt(layoutIndex),
          );
          layoutFlags[cls.getLayoutId(layoutIndex)] = dynamicDetected ? "d" : "s";
        } catch (error) {
          // Probe failed — conservatively treat as dynamic.
          layoutFlags[cls.getLayoutId(layoutIndex)] = "d";
          const errorResponse = await options.onLayoutError(error, layoutIndex);
          if (errorResponse) return errorResponse;
        }
        continue;
      }

      // No classification options — original behavior
      const errorResponse = await probeLayoutForErrors(options, layoutIndex);
      if (errorResponse) return errorResponse;
    }

    return null;
  });

  return { response, layoutFlags };
}

async function probeLayoutForErrors(
  options: ProbeAppPageLayoutsOptions,
  layoutIndex: number,
): Promise<Response | null> {
  try {
    const layoutResult = options.probeLayoutAt(layoutIndex);
    if (isPromiseLike(layoutResult)) {
      await layoutResult;
    }
  } catch (error) {
    return options.onLayoutError(error, layoutIndex);
  }
  return null;
}

export async function probeAppPageComponent(
  options: ProbeAppPageComponentOptions,
): Promise<Response | null> {
  return options.runWithSuppressedHookWarning(async () => {
    try {
      const pageResult = options.probePage();
      if (isPromiseLike(pageResult)) {
        if (options.awaitAsyncResult) {
          await pageResult;
        } else {
          void Promise.resolve(pageResult).catch(() => {});
        }
      }
    } catch (error) {
      return options.onError(error);
    }

    return null;
  });
}

export async function readAppPageTextStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(decoder.decode(value, { stream: true }));
  }

  chunks.push(decoder.decode());
  return chunks.join("");
}

export async function readAppPageBinaryStream(
  stream: ReadableStream<Uint8Array>,
): Promise<ArrayBuffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalLength = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
    totalLength += value.byteLength;
  }

  const buffer = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return buffer.buffer;
}

export function teeAppPageRscStreamForCapture(
  stream: ReadableStream<Uint8Array>,
  shouldCapture: boolean,
): AppPageRscStreamCapture {
  if (!shouldCapture) {
    return {
      capturedRscDataPromise: null,
      responseStream: stream,
    };
  }

  const [responseStream, captureStream] = stream.tee();
  return {
    capturedRscDataPromise: readAppPageBinaryStream(captureStream),
    responseStream,
  };
}

export function buildAppPageFontLinkHeader(
  preloads: readonly AppPageFontPreload[] | null | undefined,
): string {
  if (!preloads || preloads.length === 0) {
    return "";
  }

  return preloads
    .map((preload) => `<${preload.href}>; rel=preload; as=font; type=${preload.type}; crossorigin`)
    .join(", ");
}
