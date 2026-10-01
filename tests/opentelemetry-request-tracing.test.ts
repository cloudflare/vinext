import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  setFrameworkRequestRoute,
  traceFrameworkRequest,
} from "../packages/vinext/src/server/request-tracing.js";
import { traceResponseStart } from "../packages/vinext/src/server/response-start-tracing.js";

// Only the built-in OpenTelemetry integration is registered in this file, so
// the process-wide tracer records exactly when an OpenTelemetry provider does.

type RecordedSpan = { ended: boolean; name: string; type: unknown };

const apiSymbol = Symbol.for("opentelemetry.js.api.1");
const originalApi = (globalThis as Record<symbol, unknown>)[apiSymbol];

afterEach(() => {
  if (originalApi === undefined) delete (globalThis as Record<symbol, unknown>)[apiSymbol];
  else (globalThis as Record<symbol, unknown>)[apiSymbol] = originalApi;
});

function installProvider(spans: RecordedSpan[]): void {
  (globalThis as Record<symbol, unknown>)[apiSymbol] = {
    trace: {
      getTracer: () => ({
        startActiveSpan<T>(
          name: string,
          options: { attributes: Record<string, unknown> },
          callback: (span: unknown) => T,
        ): T {
          const recorded: RecordedSpan = {
            ended: false,
            name,
            type: options.attributes["next.span_type"],
          };
          spans.push(recorded);
          return callback({
            end: () => {
              recorded.ended = true;
            },
            isRecording: () => true,
            recordException() {},
            setAttribute() {},
            setStatus() {},
            spanContext: () => ({}),
            updateName: (nextName: string) => {
              recorded.name = nextName;
            },
          });
        },
      }),
    },
  };
}

function traceRequest(response: Response): Promise<Response> {
  return traceFrameworkRequest({
    callback: async () => {
      setFrameworkRequestRoute("/products/[id]");
      return traceResponseStart(response);
    },
    getStatus: (result) => result?.status,
    headers: new Headers(),
    method: "GET",
    target: "/products/42",
  });
}

describe("OpenTelemetry request tracing", () => {
  it("does not wrap the response body while no provider is registered", async () => {
    delete (globalThis as Record<symbol, unknown>)[apiSymbol];
    const original = new Response("body");

    const response = await traceRequest(original);

    expect(response).toBe(original);
    expect(await response.text()).toBe("body");
  });

  it("emits the request and response-start spans once a provider is registered", async () => {
    const spans: RecordedSpan[] = [];
    installProvider(spans);
    const original = new Response("body");

    const response = await traceRequest(original);

    expect(response).not.toBe(original);
    // The request span stays open until the response body is consumed.
    expect(spans[0]).toEqual({
      ended: false,
      name: "GET /products/[id]",
      type: "BaseServer.handleRequest",
    });
    expect(await response.text()).toBe("body");
    await vi.waitFor(() =>
      expect(spans).toEqual([
        { ended: true, name: "GET /products/[id]", type: "BaseServer.handleRequest" },
        { ended: true, name: "start response", type: "NextNodeServer.startResponse" },
      ]),
    );
  });
});
