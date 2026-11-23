// Coverage: tests/e2e/pages-router-basepath/trailing-slash.spec.ts. The
// fallback shell's hydration update follows this redirect to a page that
// redirects back to this document, without basePath.
export default function FallbackRedirectLoop() {
  return <h1 id="fallback-redirect-loop">fallback redirect loop</h1>;
}

export function getStaticPaths() {
  return { paths: [], fallback: true };
}

export function getStaticProps({ params }) {
  return { redirect: { destination: `/redirect-loop-middle/${params.slug}/`, permanent: false } };
}
