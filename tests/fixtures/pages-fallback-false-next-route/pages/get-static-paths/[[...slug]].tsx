// Ported from Next.js: test/e2e/dynamic-optional-routing/pages/get-static-paths/[[...slug]].js
type Params = { slug?: string[] };

export async function getStaticPaths() {
  return {
    paths: [
      { params: { slug: [] } },
      { params: { slug: ["p1"] } },
      { params: { slug: ["p2", "p3"] } },
    ],
    fallback: false,
  };
}

export async function getStaticProps({ params }: { params: Params }) {
  return { props: { params } };
}

export default function Page({ params }: { params: Params }) {
  return (
    <div id="route">
      gsp route: {params.slug === undefined ? "undefined" : `[${params.slug.join("|")}]`}
    </div>
  );
}
