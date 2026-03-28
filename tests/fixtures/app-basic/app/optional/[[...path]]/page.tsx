export default function OptionalCatchAll({ params }: { params: { path?: string[] } }) {
  const segments = params.path ?? [];
  return (
    <main>
      <h1>Optional Catch-All</h1>
      <p>Path: {segments.length > 0 ? segments.join("/") : "(root)"}</p>
      <p>Segments: {segments.length}</p>
    </main>
  );
}
