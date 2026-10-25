export function getStaticProps() {
  if (process.env.VINEXT_PRERENDER === "1") {
    return { redirect: { destination: "/posts/first?from=build", permanent: false } };
  }
  return { props: {} };
}

export default function RedirectPage() {
  return <p>Redirect was rerun at runtime</p>;
}
