/**
 * Regression fixture for layout generateMetadata searchParams bug.
 *
 * Before the fix, layout generateMetadata() always received `undefined`
 * for searchParams — only page generateMetadata() received the real value.
 */

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const sp = await searchParams;
  const tab = sp?.tab ?? "home";
  return {
    title: `Layout Section: ${tab}`,
  };
}

export default function LayoutMetadataSearchLayout({ children }: { children: React.ReactNode }) {
  return <div data-testid="layout-metadata-search-layout">{children}</div>;
}
