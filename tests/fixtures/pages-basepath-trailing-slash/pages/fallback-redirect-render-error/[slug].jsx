// Coverage: tests/e2e/pages-router-basepath/trailing-slash.spec.ts. The
// fallback shell's hydration update follows this redirect to a page whose
// client-side navigation render throws.
export default function FallbackRedirectRenderError() {
  return <h1>fallback redirect render error</h1>;
}

export function getStaticPaths() {
  return { paths: [], fallback: true };
}

export function getStaticProps() {
  return { redirect: { destination: "/render-error-target/", permanent: false } };
}
