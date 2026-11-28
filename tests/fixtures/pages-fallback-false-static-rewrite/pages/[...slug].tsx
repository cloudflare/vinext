export async function getStaticPaths() {
  return { paths: [{ params: { slug: ["listed"] } }], fallback: false };
}

export async function getStaticProps({ params }: { params: { slug: string[] } }) {
  return { props: { slug: params.slug } };
}

export default function Page({ slug }: { slug: string[] }) {
  return <div id="route">catch-all: {slug.join("/")}</div>;
}
