// Ported from Next.js: test/e2e/dynamic-optional-routing/pages/get-static-paths-undefined/[[...slug]].js
// https://github.com/vercel/next.js/blob/canary/test/e2e/dynamic-optional-routing/pages/get-static-paths-undefined/[[...slug]].js
export async function getStaticPaths() {
  return { paths: [{ params: { slug: undefined } }, { params: { slug: ["a"] } }], fallback: false };
}

export async function getStaticProps({ params }: { params: { slug?: string[] } }) {
  return { props: { slug: params.slug ?? null } };
}

export default function Page({ slug }: { slug: string[] | null }) {
  return <main>gsp undefined route: {slug ? `[${slug.join("|")}]` : "undefined"}</main>;
}
