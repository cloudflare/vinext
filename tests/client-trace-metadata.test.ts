/**
 * Tests for the client trace metadata renderer.
 *
 * Mirrors Next.js: test/e2e/opentelemetry/client-trace-metadata/client-trace-metadata.test.ts
 * Source: packages/next/src/server/lib/trace/utils.ts (getTracedMetadata)
 *         packages/next/src/server/app-render/make-get-server-inserted-html.tsx
 */
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  filterClientTraceMetadata,
  getClientTraceMetadataHTML,
  markClientTraceMetadataBlock,
  renderClientTraceMetadataTags,
  stripClientTraceMetadataBlock,
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

describe("client trace metadata cache marker", () => {
  it("removes only the marked framework-injected block", () => {
    const authored = '<meta name="baggage" content="application-policy"/>';
    const injected = renderClientTraceMetadataTags([
      { key: "baggage", value: "tenant=alice" },
      { key: "sentry-trace", value: "abc-def-1" },
    ]);
    const html = `<head>${authored}${markClientTraceMetadataBlock(injected, "private")}</head>`;

    expect(stripClientTraceMetadataBlock(html, "private")).toBe(`<head>${authored}</head>`);
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
  type WithRequire = { require?: (id: string) => unknown };
  const apiSymbol = Symbol.for("opentelemetry.js.api.1");
  const spanSymbol = Symbol.for("OpenTelemetry Context Key SPAN");
  const originalApiRegistry = (globalThis as Record<symbol, unknown>)[apiSymbol];
  const originalPrerender = process.env.VINEXT_PRERENDER;

  afterEach(() => {
    delete (globalThis as WithRequire).require;
    if (originalApiRegistry === undefined) {
      delete (globalThis as Record<symbol, unknown>)[apiSymbol];
    } else {
      (globalThis as Record<symbol, unknown>)[apiSymbol] = originalApiRegistry;
    }
    if (originalPrerender === undefined) {
      delete process.env.VINEXT_PRERENDER;
    } else {
      process.env.VINEXT_PRERENDER = originalPrerender;
    }
  });

  it("returns empty string when the allow-list is unset", () => {
    expect(getClientTraceMetadataHTML(undefined)).toBe("");
    expect(getClientTraceMetadataHTML([])).toBe("");
  });

  it("returns empty string when @opentelemetry/api is not installed", () => {
    (globalThis as WithRequire).require = (id: string) => {
      const err = new Error(`Cannot find module '${id}'`) as Error & { code?: string };
      err.code = "MODULE_NOT_FOUND";
      throw err;
    };
    expect(getClientTraceMetadataHTML(["my-test-key-1"])).toBe("");
  });

  it("renders <meta> tags for keys in the allow-list when an OTel propagator is registered", () => {
    const propagator = {
      inject(
        _ctx: unknown,
        carrier: ClientTraceDataEntry[],
        setter: { set(carrier: ClientTraceDataEntry[], key: string, value: string): void },
      ) {
        setter.set(carrier, "my-test-key-1", "my-test-value-1");
        setter.set(carrier, "my-test-key-2", "my-test-value-2");
        setter.set(carrier, "non-metadata-key-3", "non-metadata-key-3");
        setter.set(carrier, "my-parent-span-id", "abc123def4567890");
      },
    };

    const fakeApi = {
      context: { active: () => ({}) },
      propagation: propagator,
    };

    (globalThis as WithRequire).require = (id: string) => {
      if (id === "@opentelemetry/api") return fakeApi;
      throw new Error(`Cannot find module '${id}'`);
    };

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

  it("injects non-span metadata without creating a synthetic request span", () => {
    const rootContext = {
      values: new Map<symbol, unknown>(),
      getValue(key: symbol) {
        return this.values.get(key);
      },
      setValue(key: symbol, value: unknown) {
        const values = new Map(this.values);
        values.set(key, value);
        return { ...this, values };
      },
    };
    let currentContext = rootContext;
    const startSpan = vi.fn();
    (globalThis as Record<symbol, unknown>)[apiSymbol] = {
      version: "1.9.0",
      context: {
        active: () => currentContext,
        with<T>(context: typeof rootContext, fn: () => T): T {
          const previous = currentContext;
          currentContext = context;
          try {
            return fn();
          } finally {
            currentContext = previous;
          }
        },
      },
      propagation: {
        inject(
          context: typeof rootContext,
          carrier: ClientTraceDataEntry[],
          setter: { set(carrier: ClientTraceDataEntry[], key: string, value: string): void },
        ) {
          setter.set(carrier, "my-test-key-1", "my-test-value-1");
          const span = context.getValue(spanSymbol) as
            | { spanContext(): { spanId: string } }
            | undefined;
          if (span) setter.set(carrier, "my-parent-span-id", span.spanContext().spanId);
        },
      },
      trace: {
        getTracer: () => ({ startSpan }),
      },
    };

    expect(getClientTraceMetadataHTML(["my-test-key-1", "my-parent-span-id"])).toBe(
      '<meta name="my-test-key-1" content="my-test-value-1"/>',
    );
    expect(startSpan).not.toHaveBeenCalled();
  });

  it("preserves an existing active span instead of starting another one", () => {
    const activeSpan = { spanContext: () => ({ spanId: "0123456789abcdef" }) };
    const activeContext = {
      getValue: (key: symbol) => (key === spanSymbol ? activeSpan : undefined),
      setValue: () => activeContext,
    };
    const startSpan = vi.fn();
    (globalThis as Record<symbol, unknown>)[apiSymbol] = {
      version: "1.9.0",
      context: {
        active: () => activeContext,
        with: (_context: unknown, fn: () => unknown) => fn(),
      },
      propagation: {
        inject(
          context: typeof activeContext,
          carrier: ClientTraceDataEntry[],
          setter: { set(carrier: ClientTraceDataEntry[], key: string, value: string): void },
        ) {
          const span = context.getValue(spanSymbol) as typeof activeSpan;
          setter.set(carrier, "my-parent-span-id", span.spanContext().spanId);
        },
      },
      trace: { getTracer: () => ({ startSpan }) },
    };

    expect(getClientTraceMetadataHTML(["my-parent-span-id"])).toContain("0123456789abcdef");
    expect(startSpan).not.toHaveBeenCalled();
  });

  it("preserves non-span propagation metadata without a registered tracer provider", () => {
    const rootContext = {
      getValue: () => undefined,
      setValue: () => rootContext,
    };
    (globalThis as Record<symbol, unknown>)[apiSymbol] = {
      version: "1.9.0",
      context: { active: () => rootContext, with: (_context: unknown, fn: () => unknown) => fn() },
      propagation: {
        inject(
          _context: unknown,
          carrier: ClientTraceDataEntry[],
          setter: { set(carrier: ClientTraceDataEntry[], key: string, value: string): void },
        ) {
          setter.set(carrier, "my-test-key-1", "my-test-value-1");
        },
      },
    };

    expect(getClientTraceMetadataHTML(["my-test-key-1", "my-parent-span-id"])).toBe(
      '<meta name="my-test-key-1" content="my-test-value-1"/>',
    );
  });

  it("fails open without creating a span when registry propagation throws", () => {
    const startSpan = vi.fn();
    const rootContext = {
      getValue: () => undefined,
      setValue: () => rootContext,
    };
    (globalThis as Record<symbol, unknown>)[apiSymbol] = {
      version: "1.9.0",
      context: { active: () => rootContext, with: (_context: unknown, fn: () => unknown) => fn() },
      propagation: {
        inject() {
          throw new Error("propagation failure");
        },
      },
      trace: {
        getTracer: () => ({ startSpan }),
      },
    };

    expect(getClientTraceMetadataHTML(["my-parent-span-id"])).toBe("");
    expect(startSpan).not.toHaveBeenCalled();
  });

  it("does not emit trace metadata while prerendering", () => {
    process.env.VINEXT_PRERENDER = "1";
    (globalThis as WithRequire).require = () => ({
      context: { active: () => ({}) },
      propagation: {
        inject(
          _context: unknown,
          carrier: ClientTraceDataEntry[],
          setter: { set(carrier: ClientTraceDataEntry[], key: string, value: string): void },
        ) {
          setter.set(carrier, "my-test-key-1", "my-test-value-1");
        },
      },
    });

    expect(getClientTraceMetadataHTML(["my-test-key-1"])).toBe("");
  });

  it("does not emit trace metadata for runtime static generation", () => {
    const inject = vi.fn();
    (globalThis as Record<symbol, unknown>)[apiSymbol] = {
      context: {
        active: () => ({ getValue: () => ({}) }),
        with: (_context: unknown, fn: () => unknown) => fn(),
      },
      propagation: { inject },
    };

    expect(getClientTraceMetadataHTML(["my-test-key-1"], true)).toBe("");
    expect(inject).not.toHaveBeenCalled();
  });
});
