import { isPromiseLike } from "../utils/promise.js";
import type {
  FrameworkTracingBackendSpan,
  FrameworkTracingIntegration,
  ResolvedFrameworkSpanDescriptor,
} from "./framework-tracer.js";
import {
  getOpenTelemetryApi,
  type OpenTelemetryApi,
  type OpenTelemetrySpan,
} from "./opentelemetry-api.js";

const headersGetter = {
  get(carrier: Headers, key: string): string | undefined {
    return carrier.get(key) ?? undefined;
  },
  keys(carrier: Headers): string[] {
    return [...carrier.keys()];
  },
};

const spanKinds = {
  client: 2,
  internal: 0,
  server: 1,
} as const;

function isEnabled(api: OpenTelemetryApi): boolean {
  if (api.trace.getSpan(api.context.active())?.isRecording()) return true;

  const provider = api.trace.getTracerProvider();
  if (!("getDelegate" in provider)) return true;
  const delegate = provider.getDelegate?.() as { constructor?: { name?: string } } | undefined;
  return delegate?.constructor?.name !== "NoopTracerProvider";
}

function backendSpan(span: OpenTelemetrySpan): FrameworkTracingBackendSpan {
  return {
    recordException: (error) => span.recordException(error),
    setAttribute: (key, value) => span.setAttribute(key, value),
    setErrorStatus: (message) => span.setStatus({ code: 2, message }),
    updateName: (name) => span.updateName(name),
  };
}

const noopSpan: FrameworkTracingBackendSpan = {
  setAttribute() {},
};

/** Standard OpenTelemetry backend using the provider registered by the app. */
export const openTelemetryTracingIntegration: FrameworkTracingIntegration = {
  id: "opentelemetry",
  enterSpan<T>(
    descriptor: ResolvedFrameworkSpanDescriptor,
    callback: (span: FrameworkTracingBackendSpan) => T,
  ): T {
    const api = getOpenTelemetryApi();
    if (!api || !isEnabled(api)) return callback(noopSpan);

    return api.trace.getTracer("next.js", "0.0.1").startActiveSpan(
      descriptor.name,
      {
        attributes: descriptor.attributes,
        kind: spanKinds[descriptor.kind],
      },
      (span) => {
        try {
          const result = callback(backendSpan(span));
          if (!isPromiseLike(result)) {
            span.end();
            return result;
          }
          return Promise.resolve(result).finally(() => span.end()) as unknown as T;
        } catch (error) {
          span.end();
          throw error;
        }
      },
    );
  },

  withPropagatedContext(carrier, callback) {
    const api = getOpenTelemetryApi();
    if (!api) return callback();

    const active = api.context.active();
    if (!isEnabled(api) && !api.trace.getSpanContext(active)) return callback();
    if (api.trace.getSpanContext(active)) return callback();
    const extracted = api.propagation.extract(active, carrier, headersGetter);
    return api.context.with(extracted, callback);
  },
};
