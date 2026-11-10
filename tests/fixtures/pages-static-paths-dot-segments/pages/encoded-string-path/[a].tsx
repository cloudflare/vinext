// String entries are already encoded, so Next.js decodes `%2E%2E` to `..`
// before normalizePagePath rejects it.
export async function getStaticPaths() {
  return { paths: ["/encoded-string-path/%2E%2E"], fallback: false };
}

export async function getStaticProps({ params }: { params: { a: string } }) {
  return { props: { a: params.a } };
}

export default function EncodedStringPathPage({ a }: { a: string }) {
  return <main>Encoded string path a={a}</main>;
}
