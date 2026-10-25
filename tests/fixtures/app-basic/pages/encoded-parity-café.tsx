// Used by E2E: app-router-encoded-basepath-i18n/encoded-path-routing.spec.ts.
// Next.js matches static Pages segments by the URL-encoded request path, so
// this page is unreachable even as a rewrite destination.
export default function EncodedParityCafePage() {
  return <p>encoded-parity-cafe</p>;
}
