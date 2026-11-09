// Lists its path only on the first call, as a build-time list that drops a
// generated page would. Next.js regenerates a generated path from its
// prerender manifest without consulting getStaticPaths again.
let staticPathsCalls = 0;

export function getStaticPaths() {
  staticPathsCalls++;
  return {
    fallback: false,
    paths: staticPathsCalls === 1 ? [{ params: { slug: "listed" } }] : [],
  };
}

export function getStaticProps() {
  return { props: { renderId: crypto.randomUUID() }, revalidate: 1 };
}

export default function Page({ renderId }: { renderId: string }) {
  return <div data-testid="static-paths-regeneration-render-id">{renderId}</div>;
}
