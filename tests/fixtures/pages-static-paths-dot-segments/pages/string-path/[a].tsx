export async function getStaticPaths() {
  return { paths: ["/string-path/.."], fallback: false };
}

export async function getStaticProps({ params }: { params: { a: string } }) {
  return { props: { a: params.a } };
}

export default function StringPathPage({ a }: { a: string }) {
  return <main>String path a={a}</main>;
}
