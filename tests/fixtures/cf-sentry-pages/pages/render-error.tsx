export async function getServerSideProps() {
  return { props: {} };
}

export default function RenderErrorPage() {
  throw new Error("Intentional Sentry Pages Router render error");
}
