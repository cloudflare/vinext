export function getStaticPaths() {
  return { paths: [{ params: { id: "listed" } }], fallback: false };
}

export function getStaticProps({ params }: { params: { id: string } }) {
  return { props: { id: params.id } };
}

export default function StaticPage({ id }: { id: string }) {
  return <h1>Static page {id}</h1>;
}
