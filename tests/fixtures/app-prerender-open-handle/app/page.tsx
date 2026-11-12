// Stands in for module-scope work such as a database pool or an analytics
// client that flushes on an interval. Prerendering imports this module, and the
// open timer must not keep the build process alive.
setInterval(() => {}, 60_000);

export default function Page() {
  return <p>Hello</p>;
}
