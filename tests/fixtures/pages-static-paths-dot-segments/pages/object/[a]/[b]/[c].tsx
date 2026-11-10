// Each `..` param climbs one directory, so this entry resolves to `/`. Next.js
// fails `next build` on it: normalizePagePath throws "Requested and resolved
// page mismatch" (shared/lib/page-path/normalize-page-path.ts).
export async function getStaticPaths() {
  return {
    paths: [
      { params: { a: "safe", b: "slug", c: "page" } },
      { params: { a: "..", b: "..", c: ".." } },
    ],
    fallback: false,
  };
}

export async function getStaticProps({ params }: { params: { a: string } }) {
  return { props: { a: params.a } };
}

export default function ObjectParamsPage({ a }: { a: string }) {
  return <main>Object params a={a}</main>;
}
