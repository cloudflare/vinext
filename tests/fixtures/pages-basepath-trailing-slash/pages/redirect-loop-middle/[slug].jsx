// Coverage: tests/e2e/pages-router-basepath/trailing-slash.spec.ts. Redirects
// back to the fallback-redirect-loop document that redirected here.
export default function RedirectLoopMiddle() {
  return null;
}

export function getStaticPaths() {
  return { paths: [], fallback: "blocking" };
}

export function getStaticProps({ params }) {
  return {
    redirect: {
      destination: `/docs/fallback-redirect-loop/${params.slug}/`,
      permanent: false,
      basePath: false,
    },
  };
}
