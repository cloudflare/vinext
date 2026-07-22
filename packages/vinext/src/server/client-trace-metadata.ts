/**
 * Client trace metadata renderer.
 *
 * When `experimental.clientTraceMetadata` is configured in `next.config`,
 * vinext emits `<meta name="..." content="...">` tags in the SSR HTML head
 * for each configured key. The values are sourced from the active
 * OpenTelemetry context via the registered propagator.
 *
 * This mirrors Next.js' implementation:
 *  - packages/next/src/server/lib/trace/utils.ts (getTracedMetadata)
 *  - packages/next/src/server/app-render/make-get-server-inserted-html.tsx (traceMetaTags)
 *
 * OpenTelemetry is an optional peer — we resolve `@opentelemetry/api` at
 * runtime and silently no-op when it is not installed. This matches user
 * expectations: apps that don't configure OTel get no meta tags, and apps
 * that do get the filtered subset they asked for in `clientTraceMetadata`.
 */
import { escapeHtmlAttr } from "./html.js";

export type ClientTraceDataEntry = {
  key: string;
  value: string;
};

type TextMapSetter = {
  set(carrier: ClientTraceDataEntry[], key: string, value: string): void;
};

const carrierSetter: TextMapSetter = {
  set(carrier, key, value) {
    if (typeof key !== "string" || typeof value !== "string") return;
    carrier.push({ key, value });
  },
};

/**
 * Pull entries off the active OpenTelemetry context via the registered
 * propagator. Returns an empty array when `@opentelemetry/api` is not
 * installed or when no propagator has been registered.
 *
 * The implementation mirrors Next.js's `NextTracerImpl.getTracePropagationData`:
 * we call `propagation.inject(activeContext, entries, setter)` and let the
 * setter push entries into our carrier array. When the registered API has a
 * tracer provider but no active span, vinext creates and ends a short-lived
 * span so request-time metadata has the same parent data Next.js exposes;
 * optional OpenTelemetry failures always degrade to no metadata.
 */
type OpenTelemetryApi = {
  context: { active(): unknown };
  propagation: {
    inject(context: unknown, carrier: ClientTraceDataEntry[], setter: TextMapSetter): void;
  };
};

type OpenTelemetryContext = {
  getValue(key: symbol): unknown;
  setValue(key: symbol, value: unknown): OpenTelemetryContext;
};

type OpenTelemetryGlobal = {
  context?: {
    active(): OpenTelemetryContext;
    with<T>(context: OpenTelemetryContext, fn: () => T): T;
  };
  propagation?: {
    inject(
      context: OpenTelemetryContext,
      carrier: ClientTraceDataEntry[],
      setter: TextMapSetter,
    ): void;
  };
  trace?: {
    getTracer(name: string): {
      startSpan(
        name: string,
        options: undefined,
        context: OpenTelemetryContext,
      ): {
        end(): void;
      };
    };
  };
};

const OPEN_TELEMETRY_API_SYMBOL = Symbol.for("opentelemetry.js.api.1");
const OPEN_TELEMETRY_SPAN_SYMBOL = Symbol.for("OpenTelemetry Context Key SPAN");

function getRegisteredOpenTelemetryTraceData(): ClientTraceDataEntry[] | null {
  let metadataSpan: { end(): void } | null = null;
  try {
    const registry = (globalThis as Record<symbol, unknown>)[OPEN_TELEMETRY_API_SYMBOL] as
      | OpenTelemetryGlobal
      | undefined;
    if (!registry?.context || !registry.propagation) return null;
    const contextApi = registry.context;
    const propagation = registry.propagation;

    const activeContext = contextApi.active();
    const hasActiveSpan = activeContext.getValue(OPEN_TELEMETRY_SPAN_SYMBOL) !== undefined;
    metadataSpan = hasActiveSpan
      ? null
      : (registry.trace
          ?.getTracer("vinext")
          .startSpan("vinext.clientTraceMetadata", undefined, activeContext) ?? null);
    const context = metadataSpan
      ? activeContext.setValue(OPEN_TELEMETRY_SPAN_SYMBOL, metadataSpan)
      : activeContext;
    const entries: ClientTraceDataEntry[] = [];
    contextApi.with(context, () => {
      propagation.inject(context, entries, carrierSetter);
    });
    return entries;
  } catch {
    return [];
  } finally {
    metadataSpan?.end();
  }
}

function getOpenTelemetryTraceData(): ClientTraceDataEntry[] {
  const registeredEntries = getRegisteredOpenTelemetryTraceData();
  if (registeredEntries) return registeredEntries;

  let api: OpenTelemetryApi | undefined;
  try {
    // Use require() at runtime so `@opentelemetry/api` is an optional peer.
    // Bundlers (Vite/esbuild) leave the `require` reference alone, so apps
    // that don't install the package never hit this branch.
    const req = (globalThis as { require?: (id: string) => unknown }).require;
    if (typeof req === "function") {
      api = req("@opentelemetry/api") as OpenTelemetryApi;
    }
  } catch {
    return [];
  }

  if (!api) return [];

  try {
    const activeContext = api.context.active();
    const entries: ClientTraceDataEntry[] = [];
    api.propagation.inject(activeContext, entries, carrierSetter);
    return entries;
  } catch {
    return [];
  }
}

/**
 * Filter an entry list against the configured `clientTraceMetadata` allow-list.
 * Returns `undefined` when the allow-list is unset so callers can skip
 * rendering altogether.
 */
export function filterClientTraceMetadata(
  entries: readonly ClientTraceDataEntry[],
  allowList: readonly string[] | undefined,
): ClientTraceDataEntry[] | undefined {
  if (!allowList || allowList.length === 0) return undefined;
  const allowSet = new Set(allowList);
  return entries.filter(({ key }) => allowSet.has(key));
}

/**
 * Render the filtered entries as a sequence of self-closing `<meta>` tags.
 * Names and values are HTML-attribute escaped. Returns an empty string when
 * `entries` is empty or undefined so callers can append unconditionally.
 */
export function renderClientTraceMetadataTags(
  entries: readonly ClientTraceDataEntry[] | undefined,
): string {
  if (!entries || entries.length === 0) return "";
  let html = "";
  for (const { key, value } of entries) {
    html += `<meta name="${escapeHtmlAttr(key)}" content="${escapeHtmlAttr(value)}"/>`;
  }
  return html;
}

/**
 * Convenience helper: read OTel propagation data, filter against the
 * configured allow-list, and render the resulting `<meta>` tags. Returns an
 * empty string when the allow-list is unset, OTel is not installed, or no
 * matching keys were emitted by the propagator.
 *
 * Safe to call unconditionally on every SSR render — when nothing is
 * configured/active this is a few `try/catch`-bounded operations and returns
 * `""`.
 */
export function getClientTraceMetadataHTML(allowList: readonly string[] | undefined): string {
  if (!allowList || allowList.length === 0) return "";
  if (typeof process !== "undefined" && process.env.VINEXT_PRERENDER === "1") return "";
  const entries = getOpenTelemetryTraceData();
  const filtered = filterClientTraceMetadata(entries, allowList);
  return renderClientTraceMetadataTags(filtered);
}
