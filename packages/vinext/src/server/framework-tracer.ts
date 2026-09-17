import { isPromiseLike } from "../utils/promise.js";

type FrameworkSpanAttributeValue = string | number | boolean;

type FrameworkSpanDescriptor = {
  attributes?: Readonly<Record<string, FrameworkSpanAttributeValue | undefined>>;
  kind?: "client" | "internal" | "server";
  name?: string;
  type: string;
};

export type ResolvedFrameworkSpanDescriptor = {
  attributes: Readonly<Record<string, FrameworkSpanAttributeValue>>;
  kind: "client" | "internal" | "server";
  name: string;
  type: string;
};

export type FrameworkTracingBackendSpan = {
  recordException?(error: unknown): void;
  setAttribute(key: string, value: FrameworkSpanAttributeValue): void;
  setErrorStatus?(message?: string): void;
  updateName?(name: string): void;
};

export type FrameworkTracingIntegration = {
  getActiveSpan?(): FrameworkTracingBackendSpan | undefined;
  id: string;
  enterSpan<T>(
    descriptor: ResolvedFrameworkSpanDescriptor,
    callback: (span: FrameworkTracingBackendSpan) => T,
  ): T;
  withPropagatedContext?<T>(carrier: Headers, callback: () => T): T;
};

type FrameworkSpan = {
  recordException(error: unknown): void;
  setAttribute(key: string, value: FrameworkSpanAttributeValue | undefined): void;
  setAttributes(
    attributes: Readonly<Record<string, FrameworkSpanAttributeValue | undefined>>,
  ): void;
  setErrorStatus(message?: string): void;
  updateName(name: string): void;
};

export type FrameworkTracer = {
  getActiveScopeSpan(): FrameworkSpan | undefined;
  trace<T>(descriptor: FrameworkSpanDescriptor, callback: (span: FrameworkSpan) => T): T;
  withPropagatedContext<T>(carrier: Headers, callback: () => T): T;
};

function resolveDescriptor(descriptor: FrameworkSpanDescriptor): ResolvedFrameworkSpanDescriptor {
  const name = descriptor.name ?? descriptor.type;
  const attributes: Record<string, FrameworkSpanAttributeValue> = {
    "next.span_category": "nextjs",
    "next.span_name": name,
    "next.span_type": descriptor.type,
  };
  for (const [key, value] of Object.entries(descriptor.attributes ?? {})) {
    if (value !== undefined) attributes[key] = value;
  }
  return {
    attributes,
    kind: descriptor.kind ?? "internal",
    name,
    type: descriptor.type,
  };
}

function errorType(error: unknown): string {
  if (error instanceof Error) return error.name;
  if (error && typeof error === "object") {
    const name = (error as { constructor?: { name?: unknown } }).constructor?.name;
    if (typeof name === "string" && name) return name;
  }
  return typeof error;
}

function createCompositeSpan(spans: readonly FrameworkTracingBackendSpan[]): FrameworkSpan {
  return {
    recordException(error) {
      for (const span of spans) span.recordException?.(error);
    },
    setAttribute(key, value) {
      if (value === undefined) return;
      for (const span of spans) span.setAttribute(key, value);
    },
    setAttributes(attributes) {
      for (const [key, value] of Object.entries(attributes)) {
        if (value === undefined) continue;
        for (const span of spans) span.setAttribute(key, value);
      }
    },
    setErrorStatus(message) {
      for (const span of spans) span.setErrorStatus?.(message);
    },
    updateName(name) {
      for (const span of spans) {
        span.updateName?.(name);
        span.setAttribute("next.span_name", name);
      }
    },
  };
}

function closeWithError(span: FrameworkSpan, error: unknown): void {
  span.recordException(error);
  span.setAttribute("error.type", errorType(error));
  span.setErrorStatus(error instanceof Error ? error.message : undefined);
}

export function createFrameworkTracer(
  integrations: readonly FrameworkTracingIntegration[],
): FrameworkTracer {
  return {
    getActiveScopeSpan(): FrameworkSpan | undefined {
      const spans = integrations.flatMap((integration) => {
        const span = integration.getActiveSpan?.();
        return span ? [span] : [];
      });
      return spans.length ? createCompositeSpan(spans) : undefined;
    },

    trace<T>(descriptor: FrameworkSpanDescriptor, callback: (span: FrameworkSpan) => T): T {
      const resolved = resolveDescriptor(descriptor);
      const backendSpans: FrameworkTracingBackendSpan[] = [];

      const enter = (index: number): T => {
        const integration = integrations[index];
        if (integration) {
          return integration.enterSpan(resolved, (span) => {
            backendSpans.push(span);
            return enter(index + 1);
          });
        }

        const span = createCompositeSpan(backendSpans);
        try {
          const result = callback(span);
          if (!isPromiseLike(result)) return result;
          return Promise.resolve(result).catch((error: unknown) => {
            closeWithError(span, error);
            throw error;
          }) as T;
        } catch (error) {
          closeWithError(span, error);
          throw error;
        }
      };

      return enter(0);
    },

    withPropagatedContext<T>(carrier: Headers, callback: () => T): T {
      const enter = (index: number): T => {
        const integration = integrations[index];
        if (!integration) return callback();
        if (!integration.withPropagatedContext) return enter(index + 1);
        return integration.withPropagatedContext(carrier, () => enter(index + 1));
      };
      return enter(0);
    },
  };
}
