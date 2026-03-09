/**
 * next/form shim unit tests.
 *
 * Tests the Form component's SSR rendering for both string actions
 * (GET forms) and function actions (server actions). Verifies the
 * rendered <form> attributes match Next.js expectations.
 */
import { describe, it, expect } from "vitest";
import React from "react";
import ReactDOMServer from "react-dom/server";
import Form from "../packages/vinext/src/shims/form.js";

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
