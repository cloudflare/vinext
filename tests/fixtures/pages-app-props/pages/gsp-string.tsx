export function getStaticProps() {
  return {
    props: { fromData: "gsp" },
    revalidate: 60,
  };
}

export default function GspStringPage(props: Record<string, unknown>) {
  return <div id="page-content">{JSON.stringify(props)}</div>;
}
