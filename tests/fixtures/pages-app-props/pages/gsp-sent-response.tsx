export function getStaticProps() {
  return {
    props: { fromData: "gsp-sent-response" },
    revalidate: 60,
  };
}

export default function GspSentResponsePage(props: { fromData: string }) {
  return <div id="page-content">{props.fromData}</div>;
}
