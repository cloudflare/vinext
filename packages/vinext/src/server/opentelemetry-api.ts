/**
 * The OpenTelemetry API stores its registered context, propagation, and trace
 * APIs in a versioned global registry. Reading that registry lets vinext join
 * an application-owned provider without requiring OpenTelemetry to be
 * installed alongside vinext itself.
 */

export type OpenTelemetryContext = {
  deleteValue(key: symbol): OpenTelemetryContext;
  getValue(key: symbol): unknown;
  setValue(key: symbol, value: unknown): OpenTelemetryContext;
};

export type OpenTelemetrySpan = {
  end(): void;
  isRecording(): boolean;
  recordException(error: unknown): void;
  setAttribute(key: string, value: OpenTelemetryAttributeValue): void;
  setStatus(status: { code: number; message?: string }): void;
  spanContext(): unknown;
  updateName(name: string): void;
};

export type OpenTelemetryAttributeValue =
  | string
  | number
  | boolean
  | readonly string[]
  | readonly number[]
  | readonly boolean[];

export type OpenTelemetryApi = {
  context: {
    active(): OpenTelemetryContext;
    with<T>(context: OpenTelemetryContext, callback: () => T): T;
  };
  propagation: {
    extract(
      context: OpenTelemetryContext,
      carrier: Headers,
      getter: {
        get(carrier: Headers, key: string): string | undefined;
        keys(carrier: Headers): string[];
      },
    ): OpenTelemetryContext;
  };
  trace: {
    getSpan(context: OpenTelemetryContext): OpenTelemetrySpan | undefined;
    getSpanContext(context: OpenTelemetryContext): unknown;
    getTracer(
      name: string,
      version?: string,
    ): {
      startActiveSpan<T>(
        name: string,
        options: {
          attributes: Record<string, OpenTelemetryAttributeValue>;
          kind?: number;
        },
        callback: (span: OpenTelemetrySpan) => T,
      ): T;
    };
    getTracerProvider(): {
      getDelegate?: () => unknown;
    };
  };
};

const OPEN_TELEMETRY_API_SYMBOL = Symbol.for("opentelemetry.js.api.1");
const OPEN_TELEMETRY_SPAN_SYMBOL = Symbol.for("OpenTelemetry Context Key SPAN");

class RootContext implements OpenTelemetryContext {
  constructor(private readonly values = new Map<symbol, unknown>()) {}

  deleteValue(key: symbol): OpenTelemetryContext {
    const values = new Map(this.values);
    values.delete(key);
    return new RootContext(values);
  }

  getValue(key: symbol): unknown {
    return this.values.get(key);
  }

  setValue(key: symbol, value: unknown): OpenTelemetryContext {
    const values = new Map(this.values);
    values.set(key, value);
    return new RootContext(values);
  }
}

const ROOT_CONTEXT = new RootContext();

type OpenTelemetryRegistry = {
  context?: {
    active(): OpenTelemetryContext;
    with<T>(context: OpenTelemetryContext, callback: () => T): T;
  };
  propagation?: {
    extract(
      context: OpenTelemetryContext,
      carrier: Headers,
      getter: {
        get(carrier: Headers, key: string): string | undefined;
        keys(carrier: Headers): string[];
      },
    ): OpenTelemetryContext;
  };
  trace?: {
    getDelegate?: () => unknown;
    getTracer(name: string, version?: string): ReturnType<OpenTelemetryApi["trace"]["getTracer"]>;
  };
  version?: string;
};

function isOpenTelemetryApi(value: unknown): value is OpenTelemetryApi {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<OpenTelemetryApi>;
  return Boolean(
    typeof candidate.context?.active === "function" &&
    typeof candidate.propagation?.extract === "function" &&
    typeof candidate.trace?.getSpan === "function" &&
    typeof candidate.trace.getTracerProvider === "function",
  );
}

function apiFromRegistry(value: unknown): OpenTelemetryApi | undefined {
  if (!value || typeof value !== "object") return undefined;
  const registry = value as OpenTelemetryRegistry;
  const provider = registry.trace;
  if (typeof provider?.getTracer !== "function") return undefined;

  return {
    context: {
      active: () => registry.context?.active() ?? ROOT_CONTEXT,
      with: (context, callback) =>
        registry.context ? registry.context.with(context, callback) : callback(),
    },
    propagation: {
      extract: (context, carrier, getter) =>
        registry.propagation?.extract(context, carrier, getter) ?? context,
    },
    trace: {
      getSpan: (context) =>
        context.getValue(OPEN_TELEMETRY_SPAN_SYMBOL) as OpenTelemetrySpan | undefined,
      getSpanContext: (context) => {
        const span = context.getValue(OPEN_TELEMETRY_SPAN_SYMBOL) as OpenTelemetrySpan | undefined;
        return span?.spanContext();
      },
      getTracer: (name, version) => provider.getTracer(name, version),
      getTracerProvider: () => provider,
    },
  };
}

/** Resolve the API registered by the application, if any. */
export function getOpenTelemetryApi(): OpenTelemetryApi | undefined {
  const registered = (globalThis as Record<symbol, unknown>)[OPEN_TELEMETRY_API_SYMBOL];
  const registeredApi = apiFromRegistry(registered);
  if (registeredApi) return registeredApi;

  try {
    const require = (globalThis as { require?: (id: string) => unknown }).require;
    if (typeof require !== "function") return undefined;
    const required = require("@opentelemetry/api");
    return isOpenTelemetryApi(required) ? required : undefined;
  } catch {
    return undefined;
  }
}
