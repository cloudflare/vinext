import { describe, expect, it } from "vite-plus/test";

import {
  formatConsoleArgs,
  getStackIgnoringStrictMode,
  isAttributeOnlyHydrationWarningMessage,
  isSameReportedError,
} from "../packages/vinext/src/client/dev-console-error.js";

// The React 19 attribute-only hydration warning (the case from the repro).
const ATTRIBUTE_MISMATCH_MESSAGE =
  "A tree hydrated but some attributes of the server rendered HTML didn't match the client " +
  "properties. This won't be patched up. This can happen if a SSR-ed Client Component used:";

describe("formatConsoleArgs", () => {
  it("substitutes %s / %d / %i / %f placeholders", () => {
    expect(formatConsoleArgs(["hello %s", "world"])).toBe("hello world");
    expect(formatConsoleArgs(["count %d", 42])).toBe("count 42");
    expect(formatConsoleArgs(["idx %i", "7px"])).toBe("idx 7");
    expect(formatConsoleArgs(["ratio %f", "1.5x"])).toBe("ratio 1.5");
  });

  it("renders %o / %O objects Next.js-style (unquoted keys, depth-limited)", () => {
    expect(formatConsoleArgs(["value %o", { a: 1 }])).toBe("value {a: 1}");
    expect(formatConsoleArgs(["value %o", { a: { b: 1 } }])).toBe("value {a: {...}}");
  });

  it("appends trailing args separated by spaces", () => {
    // The first arg is the template; trailing string args are JSON.stringify'd
    // (quoted), matching Next.js — only %s-substituted strings stay bare.
    expect(formatConsoleArgs(["a", "b", "c"])).toBe('a "b" "c"');
    expect(formatConsoleArgs([{ x: 1 }])).toBe("{x: 1}");
  });

  it("renders an Error with its name, matching Next.js (arg + '')", () => {
    expect(formatConsoleArgs([new Error("boom")])).toBe("Error: boom");
    expect(formatConsoleArgs(["failed:", new Error("boom")])).toBe("failed: Error: boom");
  });

  it("preserves the React hydration diff passed via %s", () => {
    const diff = '\n+ aria-label="light"\n- aria-label="auto"';
    const message = formatConsoleArgs([`${ATTRIBUTE_MISMATCH_MESSAGE}%s`, diff]);
    expect(message).toContain("didn't match the client");
    expect(message).toContain('aria-label="light"');
    expect(message).toContain('aria-label="auto"');
  });
});

describe("getStackIgnoringStrictMode", () => {
  it("strips everything from React's react_stack_bottom_frame marker down (v8 shape)", () => {
    const stack =
      "Error: boom\n    at Component (App.tsx:5:1)\n    at Object.react_stack_bottom_frame (react-dom.development.js:100:1)\n    at renderWithHooks (react-dom.development.js:200:1)";
    expect(getStackIgnoringStrictMode(stack)).toBe("Error: boom\n    at Component (App.tsx:5:1)");
  });

  it("returns the stack unchanged when there is no bottom-frame marker", () => {
    const stack = "Error: boom\n    at Component (App.tsx:5:1)";
    expect(getStackIgnoringStrictMode(stack)).toBe(stack);
  });

  it("passes through undefined", () => {
    expect(getStackIgnoringStrictMode(undefined)).toBeUndefined();
  });
});

describe("isSameReportedError", () => {
  const base = {
    message: "boom",
    stack: "Error: boom\n    at f (a.tsx:1:1)",
    ownerStack: "at Owner",
  };

  it("matches when message, stack, and owner stack are all identical", () => {
    expect(isSameReportedError(base, { ...base })).toBe(true);
  });

  it("does not match when the message text differs", () => {
    expect(isSameReportedError(base, { ...base, message: "different" })).toBe(false);
  });

  it("does not match when the owner stack differs, even with identical message and stack", () => {
    // The false-positive case: same warning text and no per-call stack, but
    // logged from two different call sites — owner stack is what tells them
    // apart.
    expect(isSameReportedError(base, { ...base, ownerStack: "at OtherOwner" })).toBe(false);
  });

  it("matches StrictMode's double-invocation despite differing raw stacks", () => {
    const first = {
      ...base,
      stack:
        "Error: boom\n    at Component (App.tsx:5:1)\n    at Object.react_stack_bottom_frame (react-dom.development.js:100:1)\n    at renderWithHooksAgain (react-dom.development.js:201:1)",
    };
    const second = {
      ...base,
      stack:
        "Error: boom\n    at Component (App.tsx:5:1)\n    at Object.react_stack_bottom_frame (react-dom.development.js:100:1)\n    at renderWithHooks (react-dom.development.js:200:1)",
    };
    expect(isSameReportedError(first, second)).toBe(true);
  });
});

describe("isAttributeOnlyHydrationWarningMessage", () => {
  it("recognizes the attribute-only mismatch (no onRecoverableError fires)", () => {
    expect(isAttributeOnlyHydrationWarningMessage(ATTRIBUTE_MISMATCH_MESSAGE)).toBe(true);
  });

  it("does not flag recoverable text/tree mismatches", () => {
    const textMismatch =
      "Hydration failed because the server rendered text didn't match the client.";
    const nesting = "In HTML, <div> cannot be a child of <p>.\nThis will cause a hydration error.";
    for (const message of [textMismatch, nesting]) {
      expect(isAttributeOnlyHydrationWarningMessage(message)).toBe(false);
    }
  });

  it("does not flag unrelated console errors as hydration warnings", () => {
    expect(
      isAttributeOnlyHydrationWarningMessage("Warning: Each child in a list needs a key"),
    ).toBe(false);
    expect(isAttributeOnlyHydrationWarningMessage("Something else went wrong")).toBe(false);
  });
});
