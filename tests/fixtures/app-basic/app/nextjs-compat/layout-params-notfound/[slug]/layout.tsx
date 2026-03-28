import type { Metadata, Viewport } from "next";

// Regression fixture for: generateMetadata and generateViewport in a layout
// wrapping a not-found boundary should receive the actual route params (e.g. { slug })
// not an empty object {}.
// Previously renderHTTPAccessFallbackPage always passed {} for params to
// resolveModuleMetadata() / resolveModuleViewport(), so params.slug would be
// undefined inside generateMetadata / generateViewport.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  return { title: `not-found: ${slug}` };
}

export async function generateViewport({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Viewport> {
  const { slug } = await params;
  return { themeColor: `slug-${slug}` };
}

export default async function Layout({
  params,
  children,
}: {
  params: Promise<{ slug: string }>;
  children: React.ReactNode;
}) {
  const { slug } = await params;

  return (
    <div id="layout-params-notfound-wrapper" data-slug={slug}>
      {children}
    </div>
  );
}
