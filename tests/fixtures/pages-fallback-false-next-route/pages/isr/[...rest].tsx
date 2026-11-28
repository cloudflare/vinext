// An ISR page that renders the one-segment paths `isr/[slug]` rejects,
// including one it lists itself, and two it answers with a redirect or a 404.
export async function getStaticPaths() {
  return {
    paths: [
      { params: { rest: ["rest-listed"] } },
      { params: { rest: ["rest-redirect"] } },
      { params: { rest: ["rest-not-found"] } },
    ],
    fallback: "blocking",
  };
}

export async function getStaticProps({ params }: { params: { rest: string[] } }) {
  if (params.rest[0] === "rest-redirect") {
    return { redirect: { destination: "/isr/rest-listed", permanent: false } };
  }
  if (params.rest[0] === "rest-not-found") return { notFound: true };
  return { props: { rest: params.rest }, revalidate: 60 };
}

export default function Page({ rest }: { rest: string[] }) {
  return <div id="route">isr rest: [{rest.join("|")}]</div>;
}
