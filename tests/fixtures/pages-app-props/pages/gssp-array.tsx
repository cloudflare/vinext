export function getServerSideProps() {
  return { props: { fromData: "gssp" } };
}

export default function GsspArrayPage(props: Record<string, unknown>) {
  return <div id="page-content">{JSON.stringify(props)}</div>;
}
