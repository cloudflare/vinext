/**
 * Tests for ServerInsertedHTMLContext — the React Context that CSS-in-JS libraries
 * (Apollo Client, styled-components, emotion) use to register HTML injection
 * callbacks during SSR via useContext().
 *
 * These tests verify the actual integration pattern used by libraries, not just
 * structural properties of the context object.
 */
import { describe, it, expect, beforeEach } from "vite-plus/test";
import * as React from "react";
import { renderToString } from "react-dom/server";

describe("ServerInsertedHTMLContext", () => {
  beforeEach(async () => {
    const { clearServerInsertedHTML } = await import("../packages/vinext/src/shims/navigation.js");
    clearServerInsertedHTML();
  });

  it("is exported from next/navigation shim", async () => {
    const mod = await import("../packages/vinext/src/shims/navigation.js");
    expect(mod.ServerInsertedHTMLContext).toBeDefined();
  });

  it("is a valid React.Context with Provider and Consumer", async () => {
    const { ServerInsertedHTMLContext } =
      await import("../packages/vinext/src/shims/navigation.js");
    expect(ServerInsertedHTMLContext).not.toBeNull();
    expect(ServerInsertedHTMLContext).toHaveProperty("Provider");
    expect(ServerInsertedHTMLContext).toHaveProperty("Consumer");
  });

  it("has null as default value (no Provider)", async () => {
    const { ServerInsertedHTMLContext } =
      await import("../packages/vinext/src/shims/navigation.js");
    // Without a Provider, useContext returns the default value (null).
    // This is correct — Apollo checks for null and throws a clear error
    // if used outside the App Router.
    expect((ServerInsertedHTMLContext as any)._currentValue).toBeNull();
  });

  it("provides a callback registration function when wrapped with Provider", async () => {
    const { ServerInsertedHTMLContext } =
      await import("../packages/vinext/src/shims/navigation.js");

    let contextValue: unknown = "not-set";

    // Component that reads the context — simulates what Apollo does
    function ContextReader() {
      contextValue = React.useContext(ServerInsertedHTMLContext!);
      return React.createElement("div", null, "test");
    }

    // Simulate the SSR pipeline: Provider wraps the tree with a registration function
    const addCallback = (_cb: () => unknown) => {
      /* registration function */
    };
    const tree = React.createElement(
      ServerInsertedHTMLContext!.Provider,
      { value: addCallback },
      React.createElement(ContextReader),
    );

    renderToString(tree);
    expect(contextValue).toBe(addCallback);
    expect(typeof contextValue).toBe("function");
  });

  it("Apollo Client pattern: useContext returns a usable registration function", async () => {
    const { ServerInsertedHTMLContext, useServerInsertedHTML, flushServerInsertedHTML } =
      await import("../packages/vinext/src/shims/navigation.js");

    // Simulate Apollo's actual usage pattern:
    //   const insertHtml = useContext(ServerInsertedHTMLContext);
    //   if (!insertHtml) throw new Error("...");
    //   insertHtml(() => <style>...</style>);
    let apolloError: Error | null = null;

    function ApolloSSRComponent() {
      const insertHtml = React.useContext(ServerInsertedHTMLContext!);
      if (!insertHtml) {
        apolloError = new Error(
          "The SSR build of ApolloNextAppProvider cannot be used outside of the Next App Router!",
        );
        return React.createElement("div", null, "error");
      }
      // Register a style injection callback (what Apollo does for SSR)
      insertHtml(() => "<style>.apollo-ssr { color: red; }</style>");
      return React.createElement("div", null, "apollo-content");
    }

    // Wrap with Provider (simulates what handleSsr does)
    const tree = React.createElement(
      ServerInsertedHTMLContext!.Provider,
      { value: useServerInsertedHTML },
      React.createElement(ApolloSSRComponent),
    );

    const html = renderToString(tree);

    // Apollo should NOT throw
    expect(apolloError).toBeNull();
    expect(html).toContain("apollo-content");

    // The callback should have been registered via useServerInsertedHTML
    const flushed = flushServerInsertedHTML();
    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toBe("<style>.apollo-ssr { color: red; }</style>");
  });

  it("works alongside direct useServerInsertedHTML calls", async () => {
    const { ServerInsertedHTMLContext, useServerInsertedHTML, flushServerInsertedHTML } =
      await import("../packages/vinext/src/shims/navigation.js");

    // Component using direct useServerInsertedHTML (styled-components pattern)
    function StyledComponentsRegistry({ children }: { children: React.ReactNode }) {
      useServerInsertedHTML(() => "<style>.sc-1 { display: block; }</style>");
      return React.createElement(React.Fragment, null, children);
    }

    // Component using useContext (Apollo pattern)
    function ApolloRegistry() {
      const insertHtml = React.useContext(ServerInsertedHTMLContext!);
      if (insertHtml) {
        insertHtml(() => "<style>.apollo { font-weight: bold; }</style>");
      }
      return React.createElement("div", null, "app");
    }

    const tree = React.createElement(
      ServerInsertedHTMLContext!.Provider,
      { value: useServerInsertedHTML },
      React.createElement(StyledComponentsRegistry, null, React.createElement(ApolloRegistry)),
    );

    renderToString(tree);

    // Both callbacks should be in the same array
    const flushed = flushServerInsertedHTML();
    expect(flushed).toHaveLength(2);
    expect(flushed[0]).toContain(".sc-1");
    expect(flushed[1]).toContain(".apollo");
  });

  it("returns null without Provider (Apollo throws clear error)", async () => {
    const { ServerInsertedHTMLContext } =
      await import("../packages/vinext/src/shims/navigation.js");

    let contextValue: unknown = "not-set";

    function ComponentWithoutProvider() {
      contextValue = React.useContext(ServerInsertedHTMLContext!);
      return React.createElement("div", null, "no-provider");
    }

    // Render WITHOUT Provider — simulates using outside App Router
    renderToString(React.createElement(ComponentWithoutProvider));

    // Context value should be null (the default)
    expect(contextValue).toBeNull();
  });

  it("supports multiple callback registrations from context", async () => {
    const { ServerInsertedHTMLContext, useServerInsertedHTML, flushServerInsertedHTML } =
      await import("../packages/vinext/src/shims/navigation.js");

    function MultiCallbackComponent() {
      const insertHtml = React.useContext(ServerInsertedHTMLContext!);
      if (insertHtml) {
        insertHtml(() => "<style>.first {}</style>");
        insertHtml(() => "<style>.second {}</style>");
        insertHtml(() => "<style>.third {}</style>");
      }
      return React.createElement("div", null, "multi");
    }

    const tree = React.createElement(
      ServerInsertedHTMLContext!.Provider,
      { value: useServerInsertedHTML },
      React.createElement(MultiCallbackComponent),
    );

    renderToString(tree);

    const flushed = flushServerInsertedHTML();
    expect(flushed).toHaveLength(3);
    expect(flushed[0]).toContain(".first");
    expect(flushed[1]).toContain(".second");
    expect(flushed[2]).toContain(".third");
  });
});
