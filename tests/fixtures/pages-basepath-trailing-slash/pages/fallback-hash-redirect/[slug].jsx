// Coverage: tests/e2e/pages-router-basepath/trailing-slash.spec.ts. The
// fallback shell's hydration update gets a basePath-less redirect to its own
// URL with another hash, which Next.js follows as a hash-only navigation.
export default function FallbackHashRedirect() {
  return <h1 id="fallback-hash-redirect">fallback hash redirect</h1>;
}

export function getStaticPaths() {
  return { paths: [], fallback: true };
}

export function getStaticProps({ params }) {
  return {
    redirect: {
      destination: `/docs/fallback-hash-redirect/${params.slug}/#new`,
      permanent: false,
      basePath: false,
    },
  };
}
