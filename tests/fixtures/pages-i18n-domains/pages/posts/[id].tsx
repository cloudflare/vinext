export function getServerSideProps({ params }) {
  return { props: { id: params.id } };
}

export default function Post({ id }) {
  return <p id="post-id">{id}</p>;
}
