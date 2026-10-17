export function getStaticPaths() {
  return { paths: [], fallback: "blocking" };
}

export function getStaticProps({ params }: { params: { slug?: string[] } }) {
  const slug = params.slug ?? [];
  if (slug.length !== 1 || (slug[0] !== "about" && slug[0] !== "contact")) {
    return { notFound: true };
  }
  return { props: { slug } };
}

export default function CatchAll() {
  return <h1>Pages catch-all</h1>;
}
