export async function getServerSideProps() {
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  return { props: {} };
}

export default function SlowRoute() {
  return <h1>Slow route</h1>;
}
