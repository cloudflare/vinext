// Only this layout sets dynamicParams = false, above the page's [slug]. Its
// generator gives every param, so Next.js prerenders the route.
export const dynamicParams = false;

export function generateStaticParams() {
  return [
    { lang: "en", slug: "a" },
    { lang: "fr", slug: "b" },
  ];
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
