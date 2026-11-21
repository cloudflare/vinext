// The extra `%2E%2E` segment means this path matches no route. Next.js fails
// the build on it ("does not match the page") all the same.
export async function getStaticPaths() {
  return { paths: ["/mismatched-string-path/safe/%2E%2E"], fallback: false };
}

export async function getStaticProps({ params }: { params: { a: string } }) {
  return { props: { a: params.a } };
}

export default function MismatchedStringPathPage({ a }: { a: string }) {
  return <main>Mismatched string path a={a}</main>;
}
