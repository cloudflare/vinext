import type { Metadata } from "next";

// Fixture: verify generateMetadata() receives searchParams from the URL.
// The page echoes the ?q= query param into the page title so tests can assert it.
export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}): Promise<Metadata> {
  const sp = await searchParams;
  const q = sp.q ?? "(none)";
  return { title: `search: ${q}` };
}

export default function Page() {
  return <div id="metadata-generate-searchparams">metadata-generate-searchparams page</div>;
}
