export default function StaticPropsPage({ value }) {
  return <p id="sourcemap-data-static">SOURCEMAP_STATIC_COMPONENT {value}</p>;
}

export function getStaticPaths() {
  return { paths: [{ params: { slug: "SOURCEMAP_STATIC_PATHS".toLowerCase() } }], fallback: false };
}

export function getStaticProps({ params }) {
  return { props: { value: `SOURCEMAP_STATIC_PROPS ${params.slug.length}` } };
}
