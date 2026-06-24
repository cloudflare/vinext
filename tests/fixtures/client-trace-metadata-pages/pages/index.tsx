export default function Page() {
  return <h1>Pages metadata</h1>;
}
export async function getServerSideProps() {
  return { props: {} };
}
