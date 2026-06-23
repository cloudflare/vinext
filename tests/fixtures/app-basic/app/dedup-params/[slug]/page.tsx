export async function generateStaticParams() {
  // Intentionally returns duplicate param sets. Next.js dedups these before
  // rendering (filterUniqueParams), so vinext must render the concrete URL
  // once and write a single vinext-prerender.json entry. See issue #1983.
  return [{ slug: "alpha" }, { slug: "alpha" }, { slug: "beta" }];
}

export default function DedupParamsPage({ params }: { params: { slug: string } }) {
  return (
    <main>
      <h1>Dedup Params</h1>
      <p data-testid="dedup-params-slug">Slug: {params.slug}</p>
    </main>
  );
}
