// Build-time source analysis cannot read a named constant. The build must
// record the value getStaticProps returned, as Next.js does.
const REVALIDATE_SECONDS = 3600;

export function getStaticProps() {
  return { props: {}, revalidate: REVALIDATE_SECONDS };
}

export default function Hourly() {
  return (
    <main>
      <h1>Hourly page</h1>
      <p id="render-source">{process.env.VINEXT_PRERENDER === "1" ? "build-time" : "runtime"}</p>
    </main>
  );
}
