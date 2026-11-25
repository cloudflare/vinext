// The `fr` row has no `slug`, so Next.js prerenders none of the route's paths.
export function generateStaticParams() {
  return [{ lang: "en", slug: "a" }, { lang: "fr" }];
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
