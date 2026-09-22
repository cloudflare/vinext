import type {
  FrameworkTracingBackendSpan,
  FrameworkTracingIntegration,
} from "./framework-tracer.js";

export type WorkersTracingException = string | { name: string; message: string; stack?: string };

export type WorkersTracingSpan = {
  readonly isTraced: boolean;
  recordException?(exception: WorkersTracingException): void;
  setAttribute(key: string, value: boolean | number | string): void;
};

export type WorkersTracing = {
  enterSpan<T>(name: string, callback: (span: WorkersTracingSpan) => T): T;
};

function normalizeException(error: unknown): WorkersTracingException {
  if (typeof error === "string") return error;
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }
  return String(error);
}

export function createWorkersTracingIntegration(
  tracing: WorkersTracing,
): FrameworkTracingIntegration {
  const backendSpan = (span: WorkersTracingSpan): FrameworkTracingBackendSpan => ({
    recordException: (error) => span.recordException?.(normalizeException(error)),
    setAttribute: (key, value) => span.setAttribute(key, value),
  });

  return {
    id: "cloudflare-workers",
    enterSpan(descriptor, callback) {
      return tracing.enterSpan(descriptor.name, (span) => {
        for (const [key, value] of Object.entries(descriptor.attributes)) {
          span.setAttribute(key, value);
        }
        return callback(backendSpan(span));
      });
    },
  };
}
