/**
 * next/form shim unit tests.
 *
 * Tests the Form component's SSR rendering for both string actions
 * (GET forms) and function actions (server actions), plus direct
 * submit interception behavior for client-side GET forms.
 */
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import React from "react";
import ReactDOMServer from "react-dom/server";
import Form from "../packages/vinext/src/shims/form.js";

type FormEntry = [string, string];

type FormTarget = {
  entries?: FormEntry[];
};

class FakeElement {}

class FakeSubmitterElement extends FakeElement {
  disabled: boolean;
  name: string;
  value: string;
  private attributes: Record<string, string>;

  constructor({
    attributes = {},
    disabled = false,
    name = "",
    value = "",
  }: {
    attributes?: Record<string, string>;
    disabled?: boolean;
    name?: string;
    value?: string;
  } = {}) {
    super();
    this.attributes = Object.fromEntries(
      Object.entries(attributes).map(([key, value]) => [key.toLowerCase(), value]),
    );
    this.disabled = disabled;
    this.name = name;
    this.value = value;
  }

  getAttribute(name: string): string | null {
    return this.attributes[name.toLowerCase()] ?? null;
  }
}

class FakeButtonElement extends FakeSubmitterElement {}

class FakeInputElement extends FakeSubmitterElement {}

function createFormDataClass({ supportsSubmitter }: { supportsSubmitter: boolean }) {
  return class FakeFormData implements Iterable<FormEntry> {
    private entries: FormEntry[] = [];

    constructor(form?: FormTarget, submitter?: FakeSubmitterElement | null) {
      if (submitter !== undefined && submitter !== null && !supportsSubmitter) {
        throw new TypeError("submitter overload unavailable");
      }

      if (form?.entries) {
        this.entries.push(...form.entries);
      }

      if (supportsSubmitter && submitter && !submitter.disabled && submitter.name) {
        this.entries.push([submitter.name, submitter.value]);
      }
    }

    append(name: string, value: string) {
      this.entries.push([name, value]);
    }

    [Symbol.iterator](): Iterator<FormEntry> {
      return this.entries[Symbol.iterator]();
    }
  };
}

function renderClientForm(
  props: Record<string, unknown>,
  { effects = [] }: { effects?: Array<() => void | (() => void)> } = {},
) {
  // `forwardRef()` exposes the wrapped render function on `.render`, which lets us
  // exercise the submit handler directly without adding a DOM renderer just for this shim.
  //
  // Form now uses hooks (useRef, useCallback, useEffect). We patch the React 19 dispatcher
  // (ReactSharedInternals.H) with a minimal stub so hooks resolve without error outside a
  // real rendering pipeline. useEffect is a no-op; useRef returns a stable ref object;
  // useCallback returns the callback unchanged.
  const ReactSharedInternals = (React as any)
    .__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const previousDispatcher = ReactSharedInternals.H;
  const refStore: Map<number, { current: unknown }> = new Map();
  let hookIndex = 0;
  const dispatcher = {
    useRef(initialValue: unknown) {
      const idx = hookIndex++;
      if (!refStore.has(idx)) refStore.set(idx, { current: initialValue });
      return refStore.get(idx)!;
    },
    useCallback(fn: unknown) {
      return fn;
    },
    useEffect(effect: () => void | (() => void)) {
      effects.push(effect);
    },
    // Minimal pass-through for anything else that might be called
    readContext: () => null,
    useContext: () => null,
    useMemo: (fn: () => unknown) => fn(),
    useState: (init: unknown) => [init, () => {}],
    useReducer: (_reducer: unknown, init: unknown) => [init, () => {}],
    useLayoutEffect: () => {},
    useImperativeHandle: () => {},
    useDebugValue: () => {},
    useDeferredValue: (val: unknown) => val,
    useTransition: () => [false, (fn: () => void) => fn()],
    useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
    useId: () => ":test:",
    useActionState: (_action: unknown, init: unknown) => [init, () => {}, false],
  };
  ReactSharedInternals.H = dispatcher;
  hookIndex = 0;
  try {
    const rendered = (
      Form as unknown as { render: (props: Record<string, unknown>) => any }
    ).render(props);
    expect(rendered.type).toBe("form");
    return rendered.props as {
      onSubmit: (event: any) => Promise<void>;
      ref: (node: HTMLFormElement | null) => void;
    };
  } finally {
    ReactSharedInternals.H = previousDispatcher;
  }
}

function createWindowStub() {
  const navigate = vi.fn(async () => {});
  const pushState = vi.fn();
  const replaceState = vi.fn();
  const scrollTo = vi.fn();

  return {
    navigate,
    pushState,
    replaceState,
    scrollTo,
    window: {
      [Symbol.for("vinext.navigationRuntime")]: {
        bootstrap: {
          routeManifest: null,
          rsc: undefined,
        },
        functions: {
          navigate,
        },
      },
      history: {
        pushState,
        replaceState,
        state: null,
      },
      location: {
        origin: "http://localhost:3000",
        href: "http://localhost:3000/current",
        pathname: "/current",
        search: "",
        hash: "",
        hostname: "localhost",
      },
      scrollTo,
      scrollX: 0,
      scrollY: 0,
      addEventListener: () => {},
      dispatchEvent: () => {},
    },
  };
}

function createSubmitEvent({
  entries,
  submitter,
}: {
  entries: FormEntry[];
  submitter?: FakeSubmitterElement | null;
}) {
  const event = {
    currentTarget: { entries },
    defaultPrevented: false,
    nativeEvent: { submitter },
    preventDefault: vi.fn(() => {
      event.defaultPrevented = true;
    }),
  };

  return event;
}

function installClientGlobals({ supportsSubmitter }: { supportsSubmitter: boolean }) {
  const windowStub = createWindowStub();
  vi.stubGlobal("window", windowStub.window);
  vi.stubGlobal("Element", FakeElement);
  vi.stubGlobal("HTMLButtonElement", FakeButtonElement);
  vi.stubGlobal("HTMLInputElement", FakeInputElement);
  vi.stubGlobal("FormData", createFormDataClass({ supportsSubmitter }));
  return windowStub;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.doUnmock("../packages/vinext/src/shims/router.js");
  vi.unstubAllEnvs();
});

// ─── SSR rendering ──────────────────────────────────────────────────────

describe("Form SSR rendering", () => {
  it("renders a <form> element with string action", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(
        Form,
        { action: "/search" },
        React.createElement("input", { name: "q", type: "text" }),
        React.createElement("button", { type: "submit" }, "Search"),
      ),
    );
    expect(html).toContain("<form");
    expect(html).toContain('action="/search"');
    expect(html).toContain('name="q"');
    expect(html).toContain("Search");
    expect(html).toContain("</form>");
  });

  it("renders with function action (server action)", () => {
    const serverAction = async (_formData: FormData) => {
      "use server";
    };

    // Function actions are passed directly to React
    const html = ReactDOMServer.renderToString(
      React.createElement(
        Form,
        { action: serverAction as any },
        React.createElement("button", { type: "submit" }, "Submit"),
      ),
    );
    expect(html).toContain("<form");
    expect(html).toContain("Submit");
  });

  it("renders with additional HTML form attributes", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(
        Form,
        { action: "/submit", className: "my-form", id: "contact-form" },
        React.createElement("input", { name: "email", type: "email" }),
      ),
    );
    expect(html).toContain('class="my-form"');
    expect(html).toContain('id="contact-form"');
  });

  it("renders children elements", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(
        Form,
        { action: "/search" },
        React.createElement(
          "div",
          { className: "form-group" },
          React.createElement("label", null, "Query"),
          React.createElement("input", { name: "q" }),
        ),
        React.createElement("button", null, "Go"),
      ),
    );
    expect(html).toContain('class="form-group"');
    expect(html).toContain("Query");
    expect(html).toContain("Go");
  });

  it("renders without method (defaults to GET in behavior)", () => {
    const html = ReactDOMServer.renderToString(
      React.createElement(Form, { action: "/search" }, React.createElement("input", { name: "q" })),
    );
    // No explicit method attribute in HTML — browser defaults to GET
    expect(html).toContain('action="/search"');
  });
});

// ─── useActionState re-export ───────────────────────────────────────────

describe("Form useActionState", () => {
  it("exports useActionState from the module", async () => {
    const mod = await import("../packages/vinext/src/shims/form.js");
    expect(typeof mod.useActionState).toBe("function");
  });
});

describe("Form client GET interception", () => {
  for (const scheme of ["javascript", "data", "vbscript"] as const) {
    it(`blocks dangerous ${scheme}: form actions without invoking navigation`, async () => {
      const { navigate } = installClientGlobals({ supportsSubmitter: true });
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const action = `${scheme}:globalThis.__VINEXT_FORM_DANGEROUS_ACTION__=true`;
      const { onSubmit } = renderClientForm({ action });
      const event = createSubmitEvent({ entries: [] });

      expect(() => onSubmit(event)).toThrow(
        "Next.js has blocked a javascript: URL as a security precaution.",
      );

      expect(event.preventDefault).toHaveBeenCalledOnce();
      expect(error).toHaveBeenCalledWith(
        "Next.js has blocked a javascript: URL as a security precaution.",
      );
      expect(navigate).not.toHaveBeenCalled();
      expect(
        (globalThis as Record<string, unknown>).__VINEXT_FORM_DANGEROUS_ACTION__,
      ).toBeUndefined();
    });
  }

  for (const scheme of ["data", "vbscript"] as const) {
    it(`blocks dangerous ${scheme}: submitter formAction overrides`, async () => {
      const { navigate } = installClientGlobals({ supportsSubmitter: true });
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const submitter = new FakeButtonElement({
        attributes: {
          formaction: `${scheme}:globalThis.__VINEXT_FORM_DANGEROUS_SUBMITTER__=true`,
        },
      });
      const { onSubmit } = renderClientForm({ action: "/search" });
      const event = createSubmitEvent({ entries: [], submitter });

      expect(() => onSubmit(event)).toThrow(
        "Next.js has blocked a javascript: URL as a security precaution.",
      );

      expect(event.preventDefault).toHaveBeenCalledOnce();
      expect(error).toHaveBeenCalledWith(
        "Next.js has blocked a javascript: URL as a security precaution.",
      );
      expect(navigate).not.toHaveBeenCalled();
      expect(
        (globalThis as Record<string, unknown>).__VINEXT_FORM_DANGEROUS_SUBMITTER__,
      ).toBeUndefined();
    });
  }

  it("strips existing query params from the action URL and warns in development", async () => {
    const { navigate } = installClientGlobals({ supportsSubmitter: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { onSubmit } = renderClientForm({ action: "/search?lang=en" });
    const event = createSubmitEvent({
      entries: [["q", "react"]],
    });

    void onSubmit(event);

    expect(warn).toHaveBeenCalledWith(
      '<Form> received an `action` that contains search params: "/search?lang=en". This is not supported, and they will be ignored. If you need to pass in additional search params, use an `<input type="hidden" />` instead.',
    );
    expect(event.preventDefault).toHaveBeenCalledOnce();
    // navigateClientSide delegates URL push to the App Router navigation runtime.
    expect(navigate).toHaveBeenCalledWith(
      "/search?q=react",
      0,
      "navigate",
      "push",
      undefined,
      false,
      undefined,
      expect.objectContaining({ commitId: null, hash: null, id: expect.any(Number) }),
      "transition",
    );
  });

  it("honors submitter formAction, formMethod, and submitter name/value", async () => {
    const { navigate } = installClientGlobals({ supportsSubmitter: true });
    // method is a DISALLOWED_FORM_PROP; suppress the expected dev console.error.
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { onSubmit } = renderClientForm({ action: "/search", method: "POST" });
    const submitter = new FakeButtonElement({
      attributes: {
        formaction: "/search-alt",
        formmethod: "GET",
      },
      name: "source",
      value: "submitter-action",
    });
    const event = createSubmitEvent({
      entries: [
        ["q", "button"],
        ["lang", "fr"],
      ],
      submitter,
    });

    void onSubmit(event);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith(
      "/search-alt?q=button&lang=fr&source=submitter-action",
      0,
      "navigate",
      "push",
      undefined,
      false,
      undefined,
      expect.objectContaining({ commitId: null, hash: null, id: expect.any(Number) }),
      "transition",
    );
  });

  it("falls back to appending submitter name/value when FormData submitter overload is unavailable", async () => {
    const { navigate } = installClientGlobals({ supportsSubmitter: false });
    const { onSubmit } = renderClientForm({ action: "/search" });
    const submitter = new FakeButtonElement({
      attributes: {
        formaction: "/search-alt",
      },
      name: "source",
      value: "fallback-submitter",
    });
    const event = createSubmitEvent({
      entries: [
        ["q", "fallback"],
        ["lang", "de"],
      ],
      submitter,
    });

    void onSubmit(event);

    expect(navigate).toHaveBeenCalledWith(
      "/search-alt?q=fallback&lang=de&source=fallback-submitter",
      0,
      "navigate",
      "push",
      undefined,
      false,
      undefined,
      expect.objectContaining({ commitId: null, hash: null, id: expect.any(Number) }),
      "transition",
    );
  });

  it("does not intercept when submitter overrides method to POST", async () => {
    // A submitter with formmethod="POST" should suppress GET interception.
    const { navigate } = installClientGlobals({ supportsSubmitter: true });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { onSubmit } = renderClientForm({ action: "/search" });
    const submitter = new FakeButtonElement({
      attributes: { formmethod: "POST" },
    });
    const event = createSubmitEvent({
      entries: [["q", "server-action"]],
      submitter,
    });

    void onSubmit(event);

    // hasUnsupportedSubmitterAttributes fires an error and returns true → no nav.
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("<Form>'s `method` was set to an unsupported value"),
    );
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("strips submitter formAction query params and warns in development", async () => {
    const { navigate } = installClientGlobals({ supportsSubmitter: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { onSubmit } = renderClientForm({ action: "/search" });
    const submitter = new FakeButtonElement({
      attributes: {
        formaction: "/search-alt?lang=fr",
      },
      name: "source",
      value: "submitter-action",
    });
    const event = createSubmitEvent({
      entries: [["q", "button"]],
      submitter,
    });

    void onSubmit(event);

    expect(warn).toHaveBeenCalledWith(
      '<Form> received a `formAction` that contains search params: "/search-alt?lang=fr". This is not supported, and they will be ignored. If you need to pass in additional search params, use an `<input type="hidden" />` instead.',
    );
    expect(navigate).toHaveBeenCalledWith(
      "/search-alt?q=button&source=submitter-action",
      0,
      "navigate",
      "push",
      undefined,
      false,
      undefined,
      expect.objectContaining({ commitId: null, hash: null, id: expect.any(Number) }),
      "transition",
    );
  });

  it("does not intercept submitters with unsupported formTarget overrides", async () => {
    const { navigate } = installClientGlobals({ supportsSubmitter: true });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { onSubmit } = renderClientForm({ action: "/search" });
    const submitter = new FakeButtonElement({
      attributes: {
        formtarget: "_blank",
      },
    });
    const event = createSubmitEvent({
      entries: [["q", "button"]],
      submitter,
    });

    void onSubmit(event);

    expect(error).toHaveBeenCalledWith(
      `<Form>'s \`target\` was set to an unsupported value via \`formTarget="_blank"\`. This will disable <Form>'s navigation functionality. If you need this, use a native <form> element instead.`,
    );
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("bails silently for React server-action submitters ($ACTION_ID_ / $ACTION_REF_)", async () => {
    // Ported from Next.js app-dir/form.tsx: server-action submitters are detected
    // via their encoded `name` and must not be intercepted for GET navigation.
    const { navigate } = installClientGlobals({ supportsSubmitter: true });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { onSubmit } = renderClientForm({ action: "/search" });
    const submitter = new FakeButtonElement({
      attributes: { name: "$ACTION_ID_abc123", formmethod: "POST" },
    });
    const event = createSubmitEvent({ entries: [["q", "react"]], submitter });

    void onSubmit(event);

    // Bails silently — no unsupported-attribute warning, no navigation, no preventDefault.
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('bails for React client-action submitters (formAction="javascript:...")', async () => {
    // Ported from Next.js form-shared.tsx hasReactClientActionAttributes: client
    // actions encode as `formAction="javascript:..."` and can't be navigated to.
    const { navigate } = installClientGlobals({ supportsSubmitter: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { onSubmit } = renderClientForm({ action: "/search" });
    const submitter = new FakeButtonElement({
      attributes: {
        formaction: "javascript:globalThis.__VINEXT_FORM_DANGEROUS_SUBMITTER__=true",
      },
    });
    const event = createSubmitEvent({ entries: [["q", "react"]], submitter });

    void onSubmit(event);

    expect(warn).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(
      (globalThis as Record<string, unknown>).__VINEXT_FORM_DANGEROUS_SUBMITTER__,
    ).toBeUndefined();
  });

  it("respects onSubmit calling preventDefault — no client-side navigation", async () => {
    // Mirrors Next.js's `with-onsubmit-preventdefault` test:
    // .nextjs-ref/test/e2e/next-form/default/shared-tests.util.ts:235
    // When the user's onSubmit handler calls preventDefault(), we must NOT
    // intercept for soft-navigation — let the user's logic own the submit.
    const { navigate } = installClientGlobals({ supportsSubmitter: true });
    const userOnSubmit = vi.fn((event: { preventDefault: () => void }) => {
      event.preventDefault();
    });
    const { onSubmit } = renderClientForm({ action: "/search", onSubmit: userOnSubmit });
    const event = createSubmitEvent({ entries: [["q", "react"]] });

    void onSubmit(event);

    expect(userOnSubmit).toHaveBeenCalledOnce();
    expect(event.preventDefault).toHaveBeenCalledOnce();
    // Form's own preventDefault path (and navigate) should be skipped.
    expect(navigate).not.toHaveBeenCalled();
  });

  it("uses replace mode when `replace` prop is set", async () => {
    const { navigate } = installClientGlobals({ supportsSubmitter: true });
    const { onSubmit } = renderClientForm({ action: "/search", replace: true });
    const event = createSubmitEvent({ entries: [["q", "react"]] });

    void onSubmit(event);

    expect(navigate).toHaveBeenCalledWith(
      "/search?q=react",
      0,
      "navigate",
      "replace",
      undefined,
      false,
      undefined,
      expect.objectContaining({ commitId: null, hash: null, id: expect.any(Number) }),
      "transition",
    );
  });
});

describe("Form Pages Router soft navigation", () => {
  // When no App Router navigation runtime is present, the form must route via
  // the Pages Router singleton (`next/router`) so it triggers a real soft
  // navigation rather than a full MPA reload. This is the regression that
  // sub-issue #1355 calls out.
  //
  // We can't realistically boot the full Pages Router singleton inside a unit
  // test (it depends on `window.__VINEXT_ROOT__` and a Vite-generated route
  // manifest). Instead, we assert the contract that matters at the shim
  // boundary: `preventDefault` was called, so the browser's native form
  // submission (which would be a hard MPA reload) is suppressed.

  function createPagesWindowStub() {
    const pushState = vi.fn();
    const replaceState = vi.fn();
    const assign = vi.fn();
    const replace = vi.fn();
    const scrollTo = vi.fn();
    const dispatched: Event[] = [];

    return {
      pushState,
      replaceState,
      assign,
      replace,
      scrollTo,
      dispatched,
      window: {
        // Intentionally NO `vinext.navigationRuntime` — Pages Router context.
        history: {
          pushState,
          replaceState,
          state: null,
        },
        location: {
          origin: "http://localhost:3000",
          href: "http://localhost:3000/current",
          pathname: "/current",
          search: "",
          hash: "",
          hostname: "localhost",
          assign,
          replace,
        },
        scrollTo,
        scrollX: 0,
        scrollY: 0,
        addEventListener: () => {},
        dispatchEvent: (event: Event) => {
          dispatched.push(event);
          return true;
        },
      },
    };
  }

  function installPagesGlobals() {
    const stub = createPagesWindowStub();
    vi.stubGlobal("window", stub.window);
    vi.stubGlobal("Element", FakeElement);
    vi.stubGlobal("HTMLButtonElement", FakeButtonElement);
    vi.stubGlobal("HTMLInputElement", FakeInputElement);
    vi.stubGlobal("FormData", createFormDataClass({ supportsSubmitter: true }));
    vi.stubGlobal("PopStateEvent", class PopStateEvent extends Event {});
    return stub;
  }

  it("calls preventDefault to suppress the browser's hard MPA submit", async () => {
    // Regression for #1355: without interception, the browser would submit
    // the form and trigger a full page reload (`didMpaNavigate` -> true).
    // Calling preventDefault is the only thing that can stop that.
    const push = vi.fn(async () => true);
    vi.doMock("../packages/vinext/src/shims/router.js", () => ({
      default: { push, replace: vi.fn(async () => true) },
    }));
    installPagesGlobals();
    const { onSubmit } = renderClientForm({ action: "/results" });
    const event = createSubmitEvent({ entries: [["q", "react"]] });

    void onSubmit(event);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(push).toHaveBeenCalledOnce());
  });

  for (const replace of [false, true]) {
    it(`hard-navigates with location.${replace ? "replace" : "assign"} when Pages Router navigation fails`, async () => {
      const routerMethod = vi.fn(async () => {
        throw new Error("forced Pages Router setup failure");
      });
      vi.doMock("../packages/vinext/src/shims/router.js", () => ({
        default: {
          push: replace ? vi.fn(async () => true) : routerMethod,
          replace: replace ? routerMethod : vi.fn(async () => true),
        },
      }));
      const { assign, replace: replaceLocation, pushState, replaceState } = installPagesGlobals();
      const { onSubmit } = renderClientForm({ action: "/results", replace });
      const event = createSubmitEvent({ entries: [["q", "react"]] });

      void onSubmit(event);

      expect(event.preventDefault).toHaveBeenCalledOnce();
      await vi.waitFor(() =>
        expect(replace ? replaceLocation : assign).toHaveBeenCalledWith(
          "http://localhost:3000/results?q=react",
        ),
      );
      expect(pushState).not.toHaveBeenCalled();
      expect(replaceState).not.toHaveBeenCalled();
    });
  }

  it("does not call preventDefault when submitter overrides method to POST", async () => {
    // POST forms (e.g. server actions) must not be intercepted by the Form's
    // navigation logic — React's own form-action handling owns them.
    installPagesGlobals();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { onSubmit } = renderClientForm({ action: "/results" });
    const submitter = new FakeButtonElement({
      attributes: { formmethod: "POST" },
    });
    const event = createSubmitEvent({ entries: [["q", "react"]], submitter });

    void onSubmit(event);

    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  for (const [name, action, submitter] of [
    ["form action", "http://[", null],
    [
      "submitter formAction override",
      "/results",
      new FakeButtonElement({ attributes: { formaction: "http://[" } }),
    ],
  ] as const) {
    it(`retains native fallback when a malformed ${name} cannot construct a destination`, () => {
      const { assign, replace, pushState, replaceState } = installPagesGlobals();
      const { onSubmit } = renderClientForm({ action });
      const event = createSubmitEvent({ entries: [["q", "react"]], submitter });

      expect(() => onSubmit(event)).toThrow();
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(assign).not.toHaveBeenCalled();
      expect(replace).not.toHaveBeenCalled();
      expect(pushState).not.toHaveBeenCalled();
      expect(replaceState).not.toHaveBeenCalled();
    });
  }

  for (const [name, action, submitter] of [
    ["form action", "data:text/html,dangerous", null],
    [
      "submitter formAction override",
      "/results",
      new FakeButtonElement({ attributes: { formaction: "vbscript:dangerous" } }),
    ],
  ] as const) {
    it(`blocks a dangerous ${name} without falling through to history`, async () => {
      const { pushState, replaceState, dispatched } = installPagesGlobals();
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const { onSubmit } = renderClientForm({ action });
      const event = createSubmitEvent({ entries: [["q", "react"]], submitter });

      expect(() => onSubmit(event)).toThrow(
        "Next.js has blocked a javascript: URL as a security precaution.",
      );
      expect(error).toHaveBeenCalledWith(
        "Next.js has blocked a javascript: URL as a security precaution.",
      );

      expect(event.preventDefault).toHaveBeenCalledOnce();
      expect(pushState).not.toHaveBeenCalled();
      expect(replaceState).not.toHaveBeenCalled();
      expect(dispatched).toHaveLength(0);
    });
  }
});

describe("Form function action (client/server action)", () => {
  it("passes a function `action` through to React for action handling", () => {
    // Mirrors Next.js's `with-function/action-client` test path:
    // the action function must be wired up to the rendered <form>, not
    // intercepted as a navigation. The shim's job is just to thread it
    // through; React owns the FormData dispatch.
    const actionFn = vi.fn(async (_formData: FormData) => {});
    const html = ReactDOMServer.renderToString(
      React.createElement(
        Form,
        { action: actionFn as any, id: "search-form" },
        React.createElement("input", { name: "query" }),
        React.createElement("button", { type: "submit" }, "Submit"),
      ),
    );
    expect(html).toContain("<form");
    expect(html).toContain('id="search-form"');
    // We never invoke the action during SSR — but we did successfully render
    // a form with the function attached (React will bind it client-side).
    expect(actionFn).not.toHaveBeenCalled();
  });
});

// ─── DISALLOWED_FORM_PROPS ──────────────────────────────────────────────

describe("Form DISALLOWED_FORM_PROPS", () => {
  // Ported from Next.js: packages/next/src/client/app-dir/form.tsx
  // https://github.com/vercel/next.js/blob/canary/packages/next/src/client/app-dir/form.tsx

  for (const prop of ["method", "encType", "target"] as const) {
    it(`emits console.error and strips \`${prop}\` from the rendered form`, () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const html = ReactDOMServer.renderToString(
        React.createElement(
          Form,
          { action: "/search", [prop]: "bad-value" } as any,
          React.createElement("input", { name: "q" }),
        ),
      );
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining(`<Form> does not support changing \`${prop}\``),
      );
      // The disallowed prop must not appear as an attribute on the rendered <form>.
      expect(html).not.toContain(`${prop.toLowerCase()}="bad-value"`);
    });
  }

  it("emits console.error for disallowed props in test/dev mode", () => {
    // NODE_ENV is 'test' which is !== 'production', so warnings fire.
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    ReactDOMServer.renderToString(
      React.createElement(Form, { action: "/search", method: "GET" } as any),
    );
    // In non-production mode, we expect the error to have been called.
    expect(error).toHaveBeenCalled();
  });
});

// ─── File input dev warning ─────────────────────────────────────────────

describe("Form file input warning", () => {
  // Ported from Next.js: packages/next/src/client/form-shared.tsx (createFormSubmitDestinationUrl)
  // https://github.com/vercel/next.js/blob/canary/packages/next/src/client/form-shared.tsx

  it("warns in dev when FormData contains a File value", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Stub a File-like object with a name property.
    class FakeFile {
      name: string;
      constructor(name: string) {
        this.name = name;
      }
    }

    // FormData that yields a File-like entry. The FormData constructor is called
    // with a form element and an optional submitter; we ignore those and always
    // yield the faked File entry so we can exercise the dev-warning branch.
    const fileEntry: [string, FakeFile] = ["attachment", new FakeFile("photo.jpg")];
    class FileFormData {
      // No constructor needed — default constructor ignores arguments.
      [Symbol.iterator]() {
        return [fileEntry][Symbol.iterator]();
      }
      append() {}
    }

    const windowStub = createWindowStub();
    vi.stubGlobal("window", windowStub.window);
    vi.stubGlobal("Element", FakeElement);
    vi.stubGlobal("HTMLButtonElement", FakeButtonElement);
    vi.stubGlobal("HTMLInputElement", FakeInputElement);
    vi.stubGlobal("FormData", FileFormData);

    const { onSubmit } = renderClientForm({ action: "/upload" });
    // Pass a form target that buildFormData will wrap in FileFormData.
    const event = {
      currentTarget: {},
      defaultPrevented: false,
      nativeEvent: { submitter: null },
      preventDefault: vi.fn(function (this: { defaultPrevented: boolean }) {
        this.defaultPrevented = true;
      }),
    };
    // Bind preventDefault to the event so it mutates the right object.
    event.preventDefault = vi.fn(() => {
      event.defaultPrevented = true;
    });

    void onSubmit(event);

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "<Form> only supports file inputs if `action` is a function. File inputs cannot be used if `action` is a string",
      ),
    );
    // Navigation still happens, using the filename as the value.
    expect(windowStub.navigate).toHaveBeenCalledWith(
      expect.stringContaining("attachment=photo.jpg"),
      expect.any(Number),
      "navigate",
      "push",
      undefined,
      false,
      undefined,
      expect.objectContaining({ commitId: null, hash: null, id: expect.any(Number) }),
      "transition",
    );
  });
});

// ─── prefetch prop ──────────────────────────────────────────────────────

describe("Form prefetch prop", () => {
  it("viewport-prefetches App Router forms with loading-shell request metadata", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const effects: Array<() => void | (() => void)> = [];
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(new Response("prefetched")),
    );
    const observe = vi.fn();
    let intersectionCallback: IntersectionObserverCallback | undefined;

    class FakeIntersectionObserver {
      constructor(callback: IntersectionObserverCallback) {
        intersectionCallback = callback;
      }

      observe = observe;
      unobserve = vi.fn();
      disconnect = vi.fn();
      takeRecords = vi.fn(() => []);
    }

    const { window } = createWindowStub();
    vi.stubGlobal("window", {
      ...window,
      navigator: { userAgent: "Mozilla/5.0" },
    });
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);

    const { ref } = renderClientForm({ action: "/search" }, { effects });
    const form = {} as HTMLFormElement;
    ref(form);
    for (const effect of effects) effect();

    expect(observe).toHaveBeenCalledWith(form);
    intersectionCallback?.(
      [
        {
          intersectionRatio: 1,
          isIntersecting: true,
          target: form,
        } as unknown as IntersectionObserverEntry,
      ],
      {} as IntersectionObserver,
    );
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());

    const [url, init] = fetch.mock.calls[0]!;
    const requestUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    expect(requestUrl).toContain("/search");
    const headers = new Headers(init?.headers);
    expect(headers.get("Rsc")).toBe("1");
    expect(headers.get("X-Vinext-Rsc-Render-Mode")).toBe("prefetch-loading-shell");
    expect(init).toMatchObject({ credentials: "include", priority: "low", purpose: "prefetch" });
  });

  it("does not observe or fetch when prefetch={false}", () => {
    vi.stubEnv("NODE_ENV", "production");
    const effects: Array<() => void | (() => void)> = [];
    const fetch = vi.fn();
    const observe = vi.fn();

    class FakeIntersectionObserver {
      observe = observe;
      unobserve = vi.fn();
      disconnect = vi.fn();
      takeRecords = vi.fn(() => []);
    }

    const { window } = createWindowStub();
    vi.stubGlobal("window", {
      ...window,
      navigator: { userAgent: "Mozilla/5.0" },
    });
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);

    const { ref } = renderClientForm({ action: "/search", prefetch: false }, { effects });
    ref({} as HTMLFormElement);
    for (const effect of effects) effect();

    expect(observe).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not viewport-prefetch App Router forms for a bot user agent", async () => {
    // App Router Form prefetches through vinext's shared RSC prefetch path,
    // which mirrors the bot suppression applied to Link/router.prefetch.
    vi.stubEnv("NODE_ENV", "production");
    const effects: Array<() => void | (() => void)> = [];
    const fetch = vi.fn();
    const observe = vi.fn();
    let intersectionCallback: IntersectionObserverCallback | undefined;

    class FakeIntersectionObserver {
      constructor(callback: IntersectionObserverCallback) {
        intersectionCallback = callback;
      }

      observe = observe;
      unobserve = vi.fn();
      disconnect = vi.fn();
      takeRecords = vi.fn(() => []);
    }

    const { window } = createWindowStub();
    vi.stubGlobal("window", {
      ...window,
      navigator: {
        userAgent: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      },
    });
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);

    const { ref } = renderClientForm({ action: "/search" }, { effects });
    const form = {} as HTMLFormElement;
    ref(form);
    for (const effect of effects) effect();

    expect(observe).toHaveBeenCalledWith(form);
    intersectionCallback?.(
      [
        {
          intersectionRatio: 1,
          isIntersecting: true,
          target: form,
        } as unknown as IntersectionObserverEntry,
      ],
      {} as IntersectionObserver,
    );
    await Promise.resolve();

    expect(fetch).not.toHaveBeenCalled();
  });

  it("accepts prefetch={false} without errors", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => {
      ReactDOMServer.renderToString(
        React.createElement(
          Form,
          { action: "/search", prefetch: false },
          React.createElement("input", { name: "q" }),
        ),
      );
    }).not.toThrow();
    expect(error).not.toHaveBeenCalled();
  });

  it("accepts prefetch={null} without errors", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => {
      ReactDOMServer.renderToString(
        React.createElement(
          Form,
          { action: "/search", prefetch: null },
          React.createElement("input", { name: "q" }),
        ),
      );
    }).not.toThrow();
    expect(error).not.toHaveBeenCalled();
  });

  it("emits console.error for an invalid prefetch value", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    ReactDOMServer.renderToString(
      React.createElement(
        Form,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { action: "/search", prefetch: true as any },
        React.createElement("input", { name: "q" }),
      ),
    );
    expect(error).toHaveBeenCalledWith("The `prefetch` prop of <Form> must be `false` or `null`");
  });
});

// ─── function-action prop warnings ──────────────────────────────────────

describe("Form function-action prop warnings", () => {
  const serverAction = (_formData: FormData) => {};

  it("emits console.error when replace is passed with a function action", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    ReactDOMServer.renderToString(
      React.createElement(Form, { action: serverAction, replace: true }),
    );
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining(
        "Passing `replace` or `scroll` to a <Form> whose `action` is a function has no effect.",
      ),
    );
  });

  it("emits console.error when scroll is passed with a function action", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    ReactDOMServer.renderToString(
      React.createElement(Form, { action: serverAction, scroll: false }),
    );
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining(
        "Passing `replace` or `scroll` to a <Form> whose `action` is a function has no effect.",
      ),
    );
  });

  it("emits console.error when prefetch is passed with a function action", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    ReactDOMServer.renderToString(
      React.createElement(Form, { action: serverAction, prefetch: false }),
    );
    expect(error).toHaveBeenCalledWith(
      "Passing `prefetch` to a <Form> whose `action` is a function has no effect.",
    );
  });

  it("does not emit a warning when no navigation props are passed with a function action", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    ReactDOMServer.renderToString(React.createElement(Form, { action: serverAction }));
    expect(error).not.toHaveBeenCalledWith(expect.stringContaining("has no effect"));
  });
});
