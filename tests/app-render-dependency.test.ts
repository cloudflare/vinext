import { createElement } from "react";
import { renderToReadableStream } from "react-dom/server.edge";
import { describe, expect, it } from "vite-plus/test";
import {
  createAppRenderDependency,
  renderAfterAppDependencies,
  renderWithAppDependencyBarrier,
} from "../packages/vinext/src/server/app-render-dependency.js";

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
      return createElement("div", null, renderWithAppDependencyBarrier("layout", layoutDependency));
    }

    function LocalePage() {
      return createElement("p", null, `page:${activeLocale}`);
    }

    const body = await renderHtml(
      createElement(
        "div",
        null,
        createElement(LocaleLayout),
        renderAfterAppDependencies(createElement(LocalePage), [layoutDependency]),
      ),
    );

    expect(body).toContain("page:de");
    expect(body).not.toContain("page:en");
  });
});
