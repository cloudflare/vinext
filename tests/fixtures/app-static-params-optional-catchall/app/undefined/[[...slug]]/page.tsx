// Next.js reads a present `undefined` optional catch-all as its root path
// (build/static-paths/app.ts validateParams).
export function generateStaticParams() {
  return [{ slug: undefined }, { slug: ["a"] }];
}

export default async function Page({ params }: { params: Promise<{ slug?: string[] }> }) {
  const { slug } = await params;
  return <main>optional route: {slug ? `[${slug.join("|")}]` : "undefined"}</main>;
}
