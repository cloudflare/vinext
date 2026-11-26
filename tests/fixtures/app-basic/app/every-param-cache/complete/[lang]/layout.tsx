// The [lang] layout's generator gives every param, and the page below has
// none, so Next.js prerenders the route only because its rows are complete.
export function generateStaticParams() {
  return [
    { lang: "en", slug: "a" },
    { lang: "fr", slug: "b" },
  ];
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
