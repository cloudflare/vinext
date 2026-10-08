export function getStaticProps() {
  return {
    props: { source: process.env.VINEXT_PRERENDER === "1" ? "build-time" : "runtime" },
  };
}

export default function Account({ source }: { source: string }) {
  return (
    <main>
      <h1>Account</h1>
      <p id="render-source">{source}</p>
    </main>
  );
}
