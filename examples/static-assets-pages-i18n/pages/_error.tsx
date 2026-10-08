export default function ErrorPage() {
  return (
    <main>
      <h1>Custom error fallback</h1>
      <p id="render-source">{process.env.VINEXT_PRERENDER === "1" ? "build-time" : "runtime"}</p>
    </main>
  );
}
