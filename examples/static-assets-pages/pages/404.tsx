export function getStaticProps() {
  return { props: {} };
}

export default function NotFound() {
  return (
    <main>
      <h1>Static Assets page not found</h1>
      <p id="render-source">{process.env.VINEXT_PRERENDER === "1" ? "build-time" : "runtime"}</p>
    </main>
  );
}
