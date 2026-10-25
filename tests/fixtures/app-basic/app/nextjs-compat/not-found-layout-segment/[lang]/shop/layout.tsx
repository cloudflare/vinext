/**
 * Test fixture: layout between the boundary and the throwing layout. It is
 * inside the boundary's segment, so it must not render around the fallback,
 * but its metadata still applies to the 404.
 */
export const metadata = { description: "Shop layout description" };

export default function Layout({ children }: { children: React.ReactNode }) {
  return <section id="not-found-layout-segment-shop">{children}</section>;
}
