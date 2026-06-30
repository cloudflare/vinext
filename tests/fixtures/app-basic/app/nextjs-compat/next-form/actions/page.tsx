"use client";

import { useEffect, useState } from "react";
import Form from "next/form";

export default function ActionsPage() {
  const [origin, setOrigin] = useState("");

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const externalOrigin = "http://external.test";

  return (
    <main>
      <h1>Form actions</h1>
      <Form action="/nextjs-compat/next-form/search" id="ordinary-action">
        <input name="query" defaultValue="ordinary" />
        <button type="submit">Submit ordinary</button>
      </Form>
      <Form
        action={
          origin ? `${origin}/nextjs-compat/next-form/search` : "/nextjs-compat/next-form/search"
        }
        id="same-origin-absolute"
      >
        <input name="query" defaultValue="same-origin" />
        <button type="submit">Submit same-origin</button>
      </Form>
      <Form action={`${externalOrigin}/nextjs-compat/next-form/search`} id="external-absolute">
        <input name="query" defaultValue="external" />
        <button type="submit">Submit external</button>
      </Form>
      <Form action="//external.test/nextjs-compat/next-form/search" id="protocol-relative">
        <input name="query" defaultValue="protocol-relative" />
        <button type="submit">Submit protocol-relative</button>
      </Form>
      <Form action="/nextjs-compat/next-form/search" id="submitter-verbatim">
        <input name="query" defaultValue="verbatim" />
        <button
          type="submit"
          formAction="/nextjs-compat/next-form/search"
          name="source"
          value="verbatim"
        >
          Submit verbatim
        </button>
      </Form>
      <Form action="/nextjs-compat/next-form/search" id="external-submitter-override">
        <input name="query" defaultValue="submitter" />
        <button
          type="submit"
          formAction={`${externalOrigin}/nextjs-compat/next-form/search`}
          name="source"
          value="override"
        >
          Submit override
        </button>
      </Form>
      <Form action="../relative/search" id="relative-action">
        <input name="query" defaultValue="relative" />
        <button type="submit">Submit relative</button>
      </Form>
      <Form
        action="javascript:globalThis.__VINEXT_FORM_DANGEROUS_ACTION__=true"
        id="dangerous-action"
      >
        <button type="submit">Submit dangerous action</button>
      </Form>
      <Form action="/nextjs-compat/next-form/search" id="dangerous-submitter-override">
        <button
          type="submit"
          formAction="data:text/html,<script>globalThis.__VINEXT_FORM_DANGEROUS_SUBMITTER__=true</script>"
        >
          Submit dangerous override
        </button>
      </Form>
    </main>
  );
}
