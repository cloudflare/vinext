// A root catch-all page answers every path, like the root dynamic pages of
// Next.js's test/integration/dynamic-routing fixture, whose build still
// prerenders `/404` on its own:
// https://github.com/vercel/next.js/blob/canary/test/integration/dynamic-routing/test/index.test.ts
export default function DynamicPage() {
  return <p>dynamic page</p>;
}
