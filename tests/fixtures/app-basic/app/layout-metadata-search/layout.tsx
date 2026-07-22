/**
 * Parity fixture: layout generateMetadata() must NOT receive searchParams.
 *
 * In Next.js, only page generateMetadata() receives searchParams. Layouts
 * always get undefined. This fixture verifies vinext matches that behavior
 * by asserting the fallback title is produced even when a query string is
 * present in the URL.
 *
 * See: next.js resolve-metadata.ts — `isPage ? { params, searchParams } : { params }`
 */

export async function generateMetadata({
  searchParams,
}: {
  searchParams?: Promise<{ tab?: string }>;
}) {
  const sp = searchParams ? await searchParams : undefined;
  const tab = sp?.tab ?? "home";
  return {
    title: `Layout Section: ${tab}`,
  };
}

export default function LayoutMetadataSearchLayout({ children }: { children: React.ReactNode }) {
  return <div data-testid="layout-metadata-search-layout">{children}</div>;
}
