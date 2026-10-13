declare global {
  var __vinextStaticPathsCalls: number | undefined;
}

export async function getStaticPaths() {
  globalThis.__vinextStaticPathsCalls = (globalThis.__vinextStaticPathsCalls ?? 0) + 1;
  return { paths: [{ params: { slug: "listed" } }], fallback: false as const };
}

export async function getStaticProps({ params }: { params: { slug: string } }) {
  return { props: { slug: params.slug } };
}

export default function StaticPathsCalls({ slug }: { slug: string }) {
  return <p data-testid="slug">Static path {slug}</p>;
}
