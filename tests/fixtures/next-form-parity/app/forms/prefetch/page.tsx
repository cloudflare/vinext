import Form from "next/form";

export default function PrefetchPage() {
  return (
    <main>
      <Form action="/search" id="prefetch-form">
        <input name="query" defaultValue="prefetched" />
        <button type="submit">Submit prefetched</button>
      </Form>
    </main>
  );
}
