// Used by E2E: pages-router-prod/isr-data-request-cache.spec.ts — a
// `_next/data` miss must persist the full ISR entry for the HTML route.
export function getStaticPaths() {
  return { paths: [], fallback: "blocking" };
}

export function getStaticProps({ params }: { params: { slug: string } }) {
  return {
    props: { slug: params.slug, renderedAt: Date.now() },
    revalidate: 60,
  };
}

export default function IsrDataFirst({ slug, renderedAt }: { slug: string; renderedAt: number }) {
  return (
    <main>
      <p id="slug">{slug}</p>
      <p id="renderedAt">{renderedAt}</p>
    </main>
  );
}
