export default function ServerError() {
  return (
    <main>
      <h1>Static Assets server error</h1>
      <p id="render-source">{process.env.VINEXT_PRERENDER === "1" ? "build-time" : "runtime"}</p>
    </main>
  );
}
