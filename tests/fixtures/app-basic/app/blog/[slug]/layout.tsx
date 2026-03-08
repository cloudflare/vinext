/**
 * Layout for /blog/[slug] — regression fixture for layout params fix.
 *
 * Before the fix, layouts were rendered without `params` (only `children`
 * was passed). This layout reads the slug from params in both the Next.js 15
 * async style (`await params`) and the pre-15 thenable style (direct property
 * access), so a test can assert both work.
 */

export default async function BlogSlugLayout({
  params,
  children,
}: {
  params: Promise<{ slug: string }>;
  children: React.ReactNode;
}) {
  // Next.js 15 style — await the params Promise
  const { slug } = await params;

  // Pre-15 thenable style — direct property access on the thenable object.
  // Object.assign(Promise.resolve(p), p) makes both work simultaneously.
  const slugDirect = (params as unknown as { slug: string }).slug;

  return (
    <div data-testid="blog-slug-layout">
      <p data-testid="layout-slug-awaited">{slug}</p>
      <p data-testid="layout-slug-direct">{slugDirect}</p>
      {children}
    </div>
  );
}
