import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createElement } from "react";
import { renderToReadableStream } from "react-dom/server.edge";
import { describe, expect, it } from "vite-plus/test";
import {
  createAppRenderDependency,
  renderAfterAppDependencies,
  renderAppComponentWithDependencyBarrier,
} from "../packages/vinext/src/server/app-render-dependency.js";

const execFileAsync = promisify(execFile);

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    text += decoder.decode(value, { stream: true });
  }

  return text + decoder.decode();
}

async function renderHtml(element: React.ReactNode): Promise<string> {
  const stream = await renderToReadableStream(element, {
    onError(error: unknown) {
      throw error instanceof Error ? error : new Error(String(error));
    },
  });
  await stream.allReady;
  return readStream(stream);
}

describe("app render dependency helpers", () => {
  it("documents that React can render a sync sibling before an async sibling completes", async () => {
    let activeLocale = "en";

    async function LocaleLayout() {
      await Promise.resolve();
      activeLocale = "de";
      return createElement("div", null, "layout");
    }

    function LocalePage() {
      return createElement("p", null, `page:${activeLocale}`);
    }

    const body = await renderHtml(
      createElement("div", null, createElement(LocaleLayout), createElement(LocalePage)),
    );

    expect(body).toContain("page:en");
  });

  it("waits to serialize dependent entries until the barrier entry has rendered", async () => {
    let activeLocale = "en";
    const layoutDependency = createAppRenderDependency();

    async function LocaleLayout() {
      await Promise.resolve();
      activeLocale = "de";
      return createElement("div", null, "layout");
    }

    function LocalePage() {
      return createElement("p", null, `page:${activeLocale}`);
    }

    const body = await renderHtml(
      createElement(
        "div",
        null,
        renderAppComponentWithDependencyBarrier(LocaleLayout, {}, layoutDependency),
        renderAfterAppDependencies(createElement(LocalePage), [layoutDependency]),
      ),
    );

    expect(body).toContain("page:de");
    expect(body).not.toContain("page:en");
  });

  it("releases a dependency after an async component produces its Flight result", async () => {
    // Run the real helper through React Flight in a react-server subprocess.
    // React DOM schedules the old fragment-sibling barrier differently and did
    // not expose the production ordering regression.
    const script = String.raw`
      import React from "react";
      import { createServer } from "vite";
      import { renderToReadableStream } from "./node_modules/@vitejs/plugin-rsc/dist/vendor/react-server-dom/server.edge.js";

      const vite = await createServer({
        appType: "custom",
        configFile: false,
        logLevel: "silent",
        mode: "production",
        server: { middlewareMode: true },
      });

      try {
        const {
          createAppRenderDependency,
          renderAppComponentWithDependencyBarrier,
        } = await vite.ssrLoadModule(
          "/packages/vinext/src/server/app-render-dependency.tsx",
        );
        const events = [];

        function createLayout(name) {
          return async function Layout() {
            events.push(name + ":layout:start");
            await new Promise((resolve) => setTimeout(resolve, 25));
            events.push(name + ":layout:end");
            return React.createElement("section", null, name + " layout");
          };
        }

        const forwardRefLayout = createLayout("forwardRef");
        const layouts = {
          plain: createLayout("plain"),
          memo: React.memo(createLayout("memo")),
          lazy: React.lazy(async () => ({ default: createLayout("lazy") })),
          forwardRef: React.forwardRef((props, ref) => {
            events.push("forwardRef:ref:" + String(ref));
            return forwardRefLayout(props);
          }),
        };
        const model = {};

        for (const [name, Layout] of Object.entries(layouts)) {
          const dependency = createAppRenderDependency();
          model[name + ":layout"] = renderAppComponentWithDependencyBarrier(
            Layout,
            {},
            dependency,
          );
          model[name + ":page"] = React.createElement(async function Page() {
            await dependency.promise;
            events.push(name + ":page");
            return React.createElement("p", null, name + " page");
          });
        }

        const stream = renderToReadableStream(model, null, {
          onError: () => "digest",
        });
        const reader = stream.getReader();
        while (!(await reader.read()).done) {}
        process.stdout.write(JSON.stringify(events));
      } finally {
        await vite.close();
      }
    `;

    const { stdout } = await execFileAsync(
      process.execPath,
      ["--conditions", "react-server", "--input-type=module", "-e", script],
      {
        cwd: process.cwd(),
        env: { ...process.env, NODE_ENV: "production" },
        timeout: 10_000,
      },
    );

    const events = JSON.parse(stdout) as string[];
    for (const name of ["plain", "memo", "lazy", "forwardRef"]) {
      expect(events.indexOf(`${name}:layout:start`)).toBeLessThan(
        events.indexOf(`${name}:layout:end`),
      );
      expect(events.indexOf(`${name}:layout:end`)).toBeLessThan(events.indexOf(`${name}:page`));
    }
    expect(events).toContain("forwardRef:ref:undefined");
    expect(events).not.toContain("forwardRef:ref:null");
  });
});
