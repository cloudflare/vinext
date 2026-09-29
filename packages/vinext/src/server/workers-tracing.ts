import type {
  FrameworkTracingBackendSpan,
  FrameworkTracingIntegration,
} from "./framework-tracer.js";

export type WorkersTracingException =
  | string
  | { code: string | number; name?: string; message?: string; stack?: string }
  | { code?: string | number; name: string; message?: string; stack?: string }
  | { code?: string | number; name?: string; message: string; stack?: string };

export type WorkersTracingSpan = {
  readonly isTraced: boolean;
  recordException?(exception: WorkersTracingException): void;
  setAttribute(key: string, value: boolean | number | string): void;
  setStatus?(status: { code: "error"; message?: string }): void;
  updateName?(name: string): void;
};

export type WorkersTracing = {
  enterSpan<T>(name: string, callback: (span: WorkersTracingSpan) => T): T;
  getActiveSpan?(): WorkersTracingSpan | undefined;
};

function normalizeException(error: unknown): WorkersTracingException {
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const { code, name, message, stack } = error as Record<string, unknown>;
    const details = {
      ...(typeof name === "string" ? { name } : {}),
      ...(typeof message === "string" ? { message } : {}),
      ...(typeof stack === "string" ? { stack } : {}),
    };
    if (typeof code === "string" || typeof code === "number") return { ...details, code };
    if (typeof name === "string") return { ...details, name };
    if (typeof message === "string") return { ...details, message };
  }
  return String(error);
}

export function createWorkersTracingIntegration(
  tracing: WorkersTracing,
): FrameworkTracingIntegration {
  const backendSpan = (span: WorkersTracingSpan): FrameworkTracingBackendSpan => ({
    recordException: (error) => span.recordException?.(normalizeException(error)),
    setAttribute: (key, value) => span.setAttribute(key, value),
    setErrorStatus: (message) => span.setStatus?.({ code: "error", message }),
    updateName: (name) => span.updateName?.(name),
  });

  return {
    id: "cloudflare-workers",
    getActiveSpan() {
      const span = tracing.getActiveSpan?.();
      return span ? backendSpan(span) : undefined;
    },
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
