import Link from "next/link";

// The note is URL-encoded into the link and never rendered, so it only reaches
// the browser through the download's prefetch response.
export default async function PrefetchNonFlightPage({
  searchParams,
}: {
  searchParams: Promise<{ doc?: string }>;
}) {
  const { doc = "" } = await searchParams;
  return (
    <main>
      <h1 id="prefetch-non-flight-home">Prefetch non-Flight home</h1>
      <Link
        href={`/prefetch-non-flight/download?doc=${encodeURIComponent(doc)}`}
        prefetch={true}
        id="prefetch-non-flight-download"
      >
        Download the note
      </Link>
    </main>
  );
}
