import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import type { ViteDevServer } from "vite";
import {
  ROOT_CONTEXT,
  context,
  propagation,
  trace,
  type Context,
  type ContextManager,
  type TextMapPropagator,
} from "@opentelemetry/api";

type TestOpenTelemetryState = {
  registrationCount: number;
  storage: AsyncLocalStorage<Context>;
};

const TEST_OTEL_STATE = Symbol.for("vinext.test.clientTraceMetadata.otel");

function getTestOpenTelemetryState(): TestOpenTelemetryState {
  const existing = Reflect.get(globalThis, TEST_OTEL_STATE) as TestOpenTelemetryState | undefined;
  if (existing) return existing;
  const state: TestOpenTelemetryState = {
    registrationCount: 0,
    storage: new AsyncLocalStorage<Context>(),
  };
  Reflect.set(globalThis, TEST_OTEL_STATE, state);
  return state;
}

class RequestContextManager implements ContextManager {
  active(): Context {
    return getTestOpenTelemetryState().storage.getStore() ?? ROOT_CONTEXT;
  }

  with<T, A extends unknown[]>(
    activeContext: Context,
    fn: (...args: A) => T,
    thisArg?: ThisParameterType<(...args: A) => T>,
    ...args: A
  ): T {
    return getTestOpenTelemetryState().storage.run(activeContext, () => fn.apply(thisArg, args));
  }

  bind<T>(activeContext: Context, target: T): T {
    if (typeof target !== "function") return target;
    const manager = this;
    return function (this: unknown, ...args: unknown[]) {
      return manager.with(activeContext, target as (...args: unknown[]) => unknown, this, ...args);
    } as T;
  }

  enable(): this {
    return this;
  }

  disable(): this {
    getTestOpenTelemetryState().storage.disable();
    return this;
  }
}

function createRequestSpanContext(): Context {
  return trace.setSpanContext(ROOT_CONTEXT, {
    traceId: randomBytes(16).toString("hex"),
    spanId: randomBytes(8).toString("hex"),
    traceFlags: 1,
  });
}

const propagator: TextMapPropagator = {
  inject(activeContext, carrier, setter) {
    setter.set(carrier, "my-test-key-1", "my-test-value-1");
    setter.set(carrier, "non-metadata-key-2", "must-not-render");
    const spanContext = trace.getSpanContext(activeContext);
    if (spanContext) setter.set(carrier, "my-parent-span-id", spanContext.spanId);
  },
  extract(activeContext) {
    return activeContext;
  },
  fields() {
    return ["my-test-key-1", "non-metadata-key-2", "my-parent-span-id"];
  },
};

export function registerTestOpenTelemetry(): void {
  const state = getTestOpenTelemetryState();
  if (state.registrationCount > 0) return;
  context.disable();
  propagation.disable();
  context.setGlobalContextManager(new RequestContextManager());
  propagation.setGlobalPropagator(propagator);
  state.registrationCount += 1;
}

export function instrumentTestServerRequests(server: ViteDevServer): void {
  const httpServer = server.httpServer;
  if (!httpServer) throw new Error("Expected fixture server to expose an HTTP server");

  const listeners = httpServer.listeners("request") as RequestListener[];
  if (listeners.length === 0) throw new Error("Expected fixture server to have a request listener");
  for (const listener of listeners) httpServer.removeListener("request", listener);

  httpServer.on("request", (request: IncomingMessage, response: ServerResponse) => {
    const requestContext = createRequestSpanContext();
    getTestOpenTelemetryState().storage.run(requestContext, () => {
      for (const listener of listeners) listener.call(httpServer, request, response);
    });
  });
}

export function getTestOpenTelemetryRegistrationCount(): number {
  return getTestOpenTelemetryState().registrationCount;
}

export function resetTestOpenTelemetry(): void {
  context.disable();
  propagation.disable();
  getTestOpenTelemetryState().storage.disable();
  Reflect.deleteProperty(globalThis, TEST_OTEL_STATE);
}
