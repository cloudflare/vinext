/**
 * Tests for the client trace metadata renderer.
 *
 * Mirrors Next.js: test/e2e/opentelemetry/client-trace-metadata/client-trace-metadata.test.ts
 * Source: packages/next/src/server/lib/trace/utils.ts (getTracedMetadata)
 *         packages/next/src/server/app-render/make-get-server-inserted-html.tsx
 */
import {
  ROOT_CONTEXT,
  context,
  propagation,
  trace,
  type Context,
  type ContextManager,
  type TextMapPropagator,
} from "@opentelemetry/api";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  filterClientTraceMetadata,
  getClientTraceMetadataHTML,
  renderClientTraceMetadataTags,
  type ClientTraceDataEntry,
} from "../packages/vinext/src/server/client-trace-metadata.js";

describe("client trace metadata: filterClientTraceMetadata", () => {
  const entries: ClientTraceDataEntry[] = [
    { key: "my-test-key-1", value: "my-test-value-1" },
    { key: "my-test-key-2", value: "my-test-value-2" },
    { key: "non-metadata-key-3", value: "non-metadata-key-3" },
    { key: "my-parent-span-id", value: "abc123def4567890" },
  ];

  it("returns undefined when the allow-list is not configured", () => {
    expect(filterClientTraceMetadata(entries, undefined)).toBeUndefined();
  });

  it("returns undefined for an empty allow-list", () => {
    expect(filterClientTraceMetadata(entries, [])).toBeUndefined();
  });

  it("returns only the entries whose keys are in the allow-list", () => {
    const result = filterClientTraceMetadata(entries, [
      "my-test-key-1",
      "my-test-key-2",
      "my-parent-span-id",
    ]);
    expect(result).toEqual([
      { key: "my-test-key-1", value: "my-test-value-1" },
      { key: "my-test-key-2", value: "my-test-value-2" },
      { key: "my-parent-span-id", value: "abc123def4567890" },
    ]);
  });

  it("excludes keys that are not in the allow-list", () => {
    const result = filterClientTraceMetadata(entries, ["my-test-key-1"]);
    expect(result).toEqual([{ key: "my-test-key-1", value: "my-test-value-1" }]);
  });
});

describe("client trace metadata: renderClientTraceMetadataTags", () => {
  it("renders nothing for undefined or empty entries", () => {
    expect(renderClientTraceMetadataTags(undefined)).toBe("");
    expect(renderClientTraceMetadataTags([])).toBe("");
  });

  it("renders one <meta> per entry preserving order", () => {
    const html = renderClientTraceMetadataTags([
      { key: "my-test-key-1", value: "my-test-value-1" },
      { key: "my-test-key-2", value: "my-test-value-2" },
      { key: "my-parent-span-id", value: "abc123def4567890" },
    ]);

    expect(html).toContain('<meta name="my-test-key-1" content="my-test-value-1"/>');
    expect(html).toContain('<meta name="my-test-key-2" content="my-test-value-2"/>');
    expect(html).toContain('<meta name="my-parent-span-id" content="abc123def4567890"/>');
    // Order is preserved.
    expect(html.indexOf("my-test-key-1")).toBeLessThan(html.indexOf("my-test-key-2"));
    expect(html.indexOf("my-test-key-2")).toBeLessThan(html.indexOf("my-parent-span-id"));
  });

  it("HTML-escapes attribute values to prevent injection", () => {
    const html = renderClientTraceMetadataTags([
      { key: 'evil"name', value: '"><script>alert(1)</script>' },
    ]);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&quot;");
  });
});

describe("client trace metadata: getClientTraceMetadataHTML", () => {
  afterEach(() => {
    context.disable();
    propagation.disable();
  });

  it("returns empty string when the allow-list is unset", () => {
    expect(getClientTraceMetadataHTML(undefined)).toBe("");
    expect(getClientTraceMetadataHTML([])).toBe("");
  });

  it("returns empty string when OpenTelemetry delegates are not registered", () => {
    expect(getClientTraceMetadataHTML(["my-test-key-1"])).toBe("");
  });

  it("injects with a root context when only an OTel propagator is registered", () => {
    const propagator: TextMapPropagator = {
      inject(activeContext, carrier, setter) {
        expect(activeContext.getValue(Symbol("missing"))).toBeUndefined();
        setter.set(carrier, "my-test-key-1", "my-test-value-1");
      },
      extract(activeContext) {
        return activeContext;
      },
      fields() {
        return ["my-test-key-1"];
      },
    };

    expect(propagation.setGlobalPropagator(propagator)).toBe(true);
    expect(getClientTraceMetadataHTML(["my-test-key-1"])).toBe(
      '<meta name="my-test-key-1" content="my-test-value-1"/>',
    );
  });

  it("renders <meta> tags for keys in the allow-list when an OTel propagator is registered", () => {
    const activeContext = trace.setSpanContext(ROOT_CONTEXT, {
      traceId: "1234567890abcdef1234567890abcdef",
      spanId: "abc123def4567890",
      traceFlags: 1,
    });
    const contextManager: ContextManager = {
      active: () => activeContext,
      with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
        _activeContext: Context,
        fn: F,
        thisArg?: ThisParameterType<F>,
        ...args: A
      ): ReturnType<F> {
        return fn.apply(thisArg, args);
      },
      bind<T>(_activeContext: Context, target: T): T {
        return target;
      },
      enable() {
        return this;
      },
      disable() {
        return this;
      },
    };
    const propagator: TextMapPropagator = {
      inject(ctx, carrier, setter) {
        setter.set(carrier, "my-test-key-1", "my-test-value-1");
        setter.set(carrier, "my-test-key-2", "my-test-value-2");
        setter.set(carrier, "non-metadata-key-3", "non-metadata-key-3");
        setter.set(carrier, "my-parent-span-id", trace.getSpanContext(ctx)?.spanId ?? "");
      },
      extract(ctx) {
        return ctx;
      },
      fields() {
        return [];
      },
    };

    expect(context.setGlobalContextManager(contextManager)).toBe(true);
    expect(propagation.setGlobalPropagator(propagator)).toBe(true);

    const html = getClientTraceMetadataHTML([
      "my-test-key-1",
      "my-test-key-2",
      "my-parent-span-id",
    ]);

    expect(html).toContain('<meta name="my-test-key-1" content="my-test-value-1"/>');
    expect(html).toContain('<meta name="my-test-key-2" content="my-test-value-2"/>');
    expect(html).toMatch(/<meta name="my-parent-span-id" content="[a-f0-9]{16}"\/>/);
    // Keys not on the allow-list MUST NOT appear in the head.
    expect(html).not.toContain("non-metadata-key-3");
  });
});
