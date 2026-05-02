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

function renderClientForm(props: Record<string, unknown>) {
  // `forwardRef()` exposes the wrapped render function on `.render`, which lets us
  // exercise the submit handler directly without adding a DOM renderer just for this shim.
  const rendered = (Form as unknown as { render: (props: Record<string, unknown>) => any }).render(
    props,
  );
  expect(rendered.type).toBe("form");
  return rendered.props as {
    onSubmit: (event: any) => Promise<void>;
  };
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
      __VINEXT_RSC_NAVIGATE__: navigate,
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
        { action: "/submit", method: "POST", className: "my-form", id: "contact-form" },
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
  it("strips existing query params from the action URL and warns in development", async () => {
    const { navigate, scrollTo } = installClientGlobals({ supportsSubmitter: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { onSubmit } = renderClientForm({ action: "/search?lang=en" });
    const event = createSubmitEvent({
      entries: [["q", "react"]],
    });

    await onSubmit(event);

    expect(warn).toHaveBeenCalledWith(
      '<Form> received an `action` that contains search params: "/search?lang=en". This is not supported, and they will be ignored. If you need to pass in additional search params, use an `<input type="hidden" />` instead.',
    );
    expect(event.preventDefault).toHaveBeenCalledOnce();
    // navigateClientSide delegates URL push to __VINEXT_RSC_NAVIGATE__ (two-phase commit)
    expect(navigate).toHaveBeenCalledWith(
      "/search?q=react",
      0,
      "navigate",
      "push",
      undefined,
      false,
    );
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it("honors submitter formAction, formMethod, and submitter name/value", async () => {
    const { navigate } = installClientGlobals({ supportsSubmitter: true });
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

    await onSubmit(event);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith(
      "/search-alt?q=button&lang=fr&source=submitter-action",
      0,
      "navigate",
      "push",
      undefined,
      false,
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

    await onSubmit(event);

    expect(navigate).toHaveBeenCalledWith(
      "/search-alt?q=fallback&lang=de&source=fallback-submitter",
      0,
      "navigate",
      "push",
      undefined,
      false,
    );
  });

  it("does not intercept POST submissions without a submitter GET override", async () => {
    const { navigate } = installClientGlobals({ supportsSubmitter: true });
    const { onSubmit } = renderClientForm({ action: "/search", method: "POST" });
    const event = createSubmitEvent({
      entries: [["q", "server-action"]],
    });

    await onSubmit(event);

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

    await onSubmit(event);

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

    await onSubmit(event);

    expect(error).toHaveBeenCalledWith(
      `<Form>'s \`target\` was set to an unsupported value via \`formTarget="_blank"\`. This will disable <Form>'s navigation functionality. If you need this, use a native <form> element instead.`,
    );
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });
});
