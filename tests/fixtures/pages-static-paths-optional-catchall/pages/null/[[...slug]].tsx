// Ported from Next.js: test/e2e/dynamic-optional-routing/pages/get-static-paths-null/[[...slug]].js
// https://github.com/vercel/next.js/blob/canary/test/e2e/dynamic-optional-routing/pages/get-static-paths-null/[[...slug]].js
export async function getStaticPaths() {
  return { paths: [{ params: { slug: null } }, { params: { slug: ["a"] } }], fallback: false };
}

export async function getStaticProps({ params }: { params: { slug?: string[] } }) {
  return { props: { slug: params.slug ?? null } };
}

export default function Page({ slug }: { slug: string[] | null }) {
  return <main>gsp null route: {slug ? `[${slug.join("|")}]` : "undefined"}</main>;
}
