import { describe, expect, it, vi } from "vite-plus/test";
import { loadBeforeInteractiveRuntimeRecords } from "../packages/vinext/src/server/app-before-interactive-runtime.js";
import { scriptCache } from "../packages/vinext/src/shims/script-loader.js";

type RuntimeRecord = [src: string | 0, props: Record<string, unknown>];

type MockScript = {
  attrs: Record<string, string>;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  src: string;
  text: string;
  async: boolean;
  defer: boolean;
  noModule: boolean;
  onload: (() => void) | null;
  onerror: ((error: unknown) => void) | null;
};

function createRuntimeDocument(onAppend?: (script: MockScript) => void) {
  const scripts: MockScript[] = [];
  return {
    scripts,
    document: {
      createElement(): MockScript {
        return {
          attrs: {},
          setAttribute(name, value) {
            this.attrs[name] = value;
          },
          removeAttribute(name) {
            delete this.attrs[name];
          },
          src: "",
          text: "",
          async: true,
          defer: false,
          noModule: false,
          onload: null,
          onerror: null,
        };
      },
      head: {
        appendChild(script: MockScript) {
          scripts.push(script);
          onAppend?.(script);
        },
      },
    },
  };
}

describe("App beforeInteractive runtime records", () => {
  it("continues after an initial source fails so later records can load", async () => {
    const scope: { __next_s: RuntimeRecord[] } = {
      __next_s: [
        ["/missing.js", {}],
        [0, { children: "window.afterFailure = true" }],
      ],
    };
    const error = new Error("blocked script");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { document, scripts } = createRuntimeDocument((script) => {
      if (script.src) queueMicrotask(() => script.onerror?.(error));
    });

    await loadBeforeInteractiveRuntimeRecords(scope, document);

    expect(scripts).toHaveLength(2);
    expect(scripts[1]?.text).toBe("window.afterFailure = true");
    expect(consoleError).toHaveBeenCalledWith(error);
    consoleError.mockRestore();
  });

  it("publishes a rejected source load while continuing later records", async () => {
    const scope: {
      __next_s: RuntimeRecord[];
      __VINEXT_APP_SCRIPT__?: (
        scriptKey: string,
        subscription?: {
          src: string;
          onReady?: () => void;
          onError?: (error: unknown) => void;
        },
      ) => boolean;
    } = {
      __next_s: [
        ["/failed.js", {}],
        [0, { children: "window.afterFailure = true" }],
      ],
    };
    const error = new Error("failed runtime script");
    const onReady = vi.fn();
    const onError = vi.fn();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { document, scripts } = createRuntimeDocument((script) => {
      if (script.src) queueMicrotask(() => script.onerror?.(error));
    });

    const bootstrap = loadBeforeInteractiveRuntimeRecords(scope, document);
    await vi.waitFor(() => expect(scriptCache.get("/failed.js")).toBeInstanceOf(Promise));
    scope.__VINEXT_APP_SCRIPT__?.("src:/failed.js", {
      src: "/failed.js",
      onReady,
      onError,
    });
    await bootstrap;

    expect(onError).toHaveBeenCalledWith(error);
    expect(onReady).not.toHaveBeenCalled();
    expect(scripts[0]?.attrs["data-vinext-script-status"]).toBe("error");
    expect(scripts[1]?.text).toBe("window.afterFailure = true");
    consoleError.mockRestore();
  });

  it("waits for records pushed while an initial source is loading", async () => {
    const scope: { __next_s: RuntimeRecord[] } = {
      __next_s: [["/blocking.js", {}]],
    };
    let resolveBlockingScript: (() => void) | undefined;
    const { document, scripts } = createRuntimeDocument((script) => {
      if (script.src) resolveBlockingScript = () => script.onload?.();
    });

    let bootstrapResolved = false;
    const bootstrap = loadBeforeInteractiveRuntimeRecords(scope, document).then(() => {
      bootstrapResolved = true;
    });
    await vi.waitFor(() => expect(resolveBlockingScript).toBeTypeOf("function"));

    scope.__next_s.push(["/streamed.js", {}]);
    resolveBlockingScript?.();
    await vi.waitFor(() => expect(scripts).toHaveLength(2));

    expect(bootstrapResolved).toBe(false);
    scripts[1]?.onload?.();
    await bootstrap;
    expect(scripts[1]?.src).toBe("/streamed.js");
  });

  it("materializes contextual nonces and numeric attributes", async () => {
    const scope: { __next_s: RuntimeRecord[] } = {
      __next_s: [
        [
          0,
          {
            children: "window.attributesLoaded = true",
            nonce: "context-nonce",
            "data-version": 2,
            async: false,
          },
        ],
      ],
    };
    const { document, scripts } = createRuntimeDocument();

    await loadBeforeInteractiveRuntimeRecords(scope, document);

    expect(scripts[0]?.attrs).toEqual({
      nonce: "context-nonce",
      "data-version": "2",
    });
    expect(scripts[0]?.async).toBe(false);
  });
});
