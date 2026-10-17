export function getServerSideProps({ params }: { params: { id: string } }) {
  if (params.id === "found") return { props: { id: params.id } };
  return { notFound: true };
}

export default function SsrPage({ id }: { id: string }) {
  return <h1>SSR page {id}</h1>;
}
