import Form from "next/form";

export default function PrefetchPage() {
  return (
    <main>
      <Form action="/nextjs-compat/next-form/search" id="prefetch-form">
        <input name="query" defaultValue="prefetched" />
        <button type="submit">Submit prefetched</button>
      </Form>
    </main>
  );
}
