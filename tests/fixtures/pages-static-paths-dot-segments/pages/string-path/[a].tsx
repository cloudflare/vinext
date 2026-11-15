// `%2F` keeps `foo/../bar` in one segment, so Next.js builds that entry.
export async function getStaticPaths() {
  return { paths: ["/string-path/foo%2F..%2Fbar", "/string-path/.."], fallback: false };
}

export async function getStaticProps({ params }: { params: { a: string } }) {
  return { props: { a: params.a } };
}

export default function StringPathPage({ a }: { a: string }) {
  return <main>String path a={a}</main>;
}
