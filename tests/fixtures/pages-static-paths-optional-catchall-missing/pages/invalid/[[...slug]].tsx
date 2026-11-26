// Ported from Next.js: test/e2e/dynamic-optional-routing/fixtures/missing-param.js
// https://github.com/vercel/next.js/blob/canary/test/e2e/dynamic-optional-routing/fixtures/missing-param.js
export async function getStaticPaths() {
  return { paths: [{ params: {} }], fallback: false };
}

export async function getStaticProps({ params }: { params: { slug?: string[] } }) {
  return { props: { params } };
}

export default function Page() {
  return <main>Invalid</main>;
}
