// The second `fallback: false` route a `/chain/<one segment>` path matches.
export async function getStaticPaths() {
  return { paths: [{ params: { rest: ["rest-listed"] } }], fallback: false };
}

export async function getStaticProps({ params }: { params: { rest: string[] } }) {
  return { props: { rest: params.rest } };
}

export default function Page({ rest }: { rest: string[] }) {
  return <div id="route">chain rest: [{rest.join("|")}]</div>;
}
