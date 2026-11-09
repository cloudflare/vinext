// Used by E2E: app-router/multiple-root-layouts.spec.ts. Without app/layout,
// Next.js renders this not-found with no layout, so it owns the document.
export default function AppNotFound() {
  return (
    <html lang="en">
      <body id="app-not-found-root">
        <p id="app-not-found">app not found</p>
      </body>
    </html>
  );
}
