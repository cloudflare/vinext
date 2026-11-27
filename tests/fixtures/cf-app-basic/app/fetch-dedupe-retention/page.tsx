import { headers } from "next/headers";

// Two Server Components fetching the same URL in one render: the second fetch
// is served from the request's fetch dedupe map.
async function Data({ id }: { id: string }) {
  const host = (await headers()).get("host");
  const res = await fetch(`http://${host}/api/fetch-dedupe-retention-data`, { cache: "no-store" });
  const text = await res.text();
  return (
    <p id={id}>
      {id}: {text.length}
    </p>
  );
}

export default function FetchDedupeRetentionPage() {
  return (
    <main>
      <h1>fetch-dedupe-retention</h1>
      <Data id="first" />
      <Data id="second" />
    </main>
  );
}
