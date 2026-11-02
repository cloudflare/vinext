// In a hybrid build `next build` replaces the Pages Router's 404.html with the
// App Router's not-found page (moveExportedAppNotFoundTo404).
export default function NotFound() {
  return <p>app not found</p>;
}
