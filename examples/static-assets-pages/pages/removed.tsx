const REVALIDATE_SECONDS = 120;

export function getStaticProps() {
  if (process.env.VINEXT_PRERENDER === "1") {
    return { notFound: true, revalidate: REVALIDATE_SECONDS };
  }
  return { props: {} };
}

export default function RemovedPage() {
  return <p>notFound was rerun at runtime</p>;
}
