export async function getServerSideProps() {
  return { props: {} };
}

export default function ConfiguredPagesSsr() {
  return <h1>Pages SSR with an explicit config cache policy</h1>;
}
