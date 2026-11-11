import React from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { probeReactServerSubtree } from "../packages/vinext/src/server/app-page-probe.js";

describe("app page probe helpers", () => {
  it("probes server components returned below a layout result", async () => {
    const calls: string[] = [];

    function Child() {
      calls.push("child");
      return null;
    }

    function Layout() {
      calls.push("layout");
      return React.createElement("section", null, React.createElement(Child));
    }

    await probeReactServerSubtree(React.createElement(Layout));

    expect(calls).toEqual(["layout", "child"]);
  });

  it("does not invoke client references returned below a layout result", async () => {
    const ClientReference = Object.assign(
      vi.fn(() => {
        throw new Error("client reference must not execute on the server");
      }),
      { $$typeof: Symbol.for("react.client.reference") },
    );

    function Layout() {
      return React.createElement("section", null, React.createElement(ClientReference));
    }

    await probeReactServerSubtree(React.createElement(Layout));

    expect(ClientReference).not.toHaveBeenCalled();
  });

  it("probes memo and forwardRef server components returned below a layout result", async () => {
    const calls: string[] = [];

    const MemoChild = React.memo(function MemoChild() {
      calls.push("memo");
      return null;
    });
    const ForwardRefChild = React.forwardRef(function ForwardRefChild() {
      calls.push("forwardRef");
      return null;
    });
    const MemoForwardRefChild = React.memo(
      React.forwardRef(function MemoForwardRefChild() {
        calls.push("memoForwardRef");
        return null;
      }),
    );

    function Layout() {
      calls.push("layout");
      return React.createElement(
        "section",
        null,
        React.createElement(MemoChild),
        React.createElement(ForwardRefChild),
        React.createElement(MemoForwardRefChild),
      );
    }

    await probeReactServerSubtree(React.createElement(Layout));

    expect(calls).toEqual(["layout", "memo", "forwardRef", "memoForwardRef"]);
  });

  it("probes lazy server components returned below a layout result", async () => {
    const calls: string[] = [];

    const LazyChild = React.lazy(() =>
      Promise.resolve({
        default() {
          calls.push("lazy");
          return null;
        },
      }),
    );

    function Layout() {
      calls.push("layout");
      return React.createElement("section", null, React.createElement(LazyChild));
    }

    await probeReactServerSubtree(React.createElement(Layout));

    expect(calls).toEqual(["layout", "lazy"]);
  });

  it("enforces subtree depth limits for nested arrays", async () => {
    await expect(
      probeReactServerSubtree([[[React.createElement("span")]]], { maxDepth: 1 }),
    ).rejects.toThrow("App page layout subtree probe exceeded max depth");
  });

  it("enforces subtree node limits for large arrays", async () => {
    await expect(probeReactServerSubtree([1, 2, 3], { maxNodes: 2 })).rejects.toThrow(
      "App page layout subtree probe exceeded max nodes",
    );
  });

  it("does not consume single-use iterables while probing layout children", async () => {
    function Child() {
      return null;
    }

    function* createChildren() {
      yield React.createElement(Child);
    }

    const sharedChildren = createChildren();

    function Layout() {
      return React.createElement("section", null, sharedChildren);
    }

    await expect(probeReactServerSubtree(React.createElement(Layout))).rejects.toThrow(
      "App page layout subtree probe cannot safely inspect iterable children",
    );
    expect(sharedChildren.next().value).toMatchObject({ type: Child });
  });
});
