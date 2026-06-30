import Form from "next/form";

export default function PrefetchFalsePage() {
  return (
    <Form action="/nextjs-compat/next-form/search" prefetch={false} id="no-prefetch-form">
      <input name="query" defaultValue="not-prefetched" />
      <button type="submit">Submit without prefetch</button>
    </Form>
  );
}
