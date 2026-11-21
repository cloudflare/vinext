const REVALIDATE_SECONDS = 240;

export function getStaticProps() {
  if (process.env.VINEXT_PRERENDER === "1") {
    return {
      redirect: { destination: "/posts/first?from=build", permanent: false },
      revalidate: REVALIDATE_SECONDS,
    };
  }
  return { props: {} };
}

export default function RedirectPage() {
  return <p>Redirect was rerun at runtime</p>;
}
