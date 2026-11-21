"use client";

import Form from "next/form";

export default function QueueForm() {
  return (
    <Form id="queue-form" action="/prefetch-queue-viewport/9">
      <input name="q" />
      <button type="submit">Search</button>
    </Form>
  );
}
