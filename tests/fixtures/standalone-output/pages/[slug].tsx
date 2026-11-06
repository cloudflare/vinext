// The only listed slug is `index`, whose prerendered files must not
// overwrite the home page's `index.html`, as in Next.js.
export function getStaticPaths() {
  return { paths: [{ params: { slug: "index" } }], fallback: false };
}

export function getStaticProps({ params }: { params: { slug: string } }) {
  return { props: { slug: params.slug } };
}

export default function Slug({ slug }: { slug: string }) {
  return <h1>Standalone slug page: {slug}</h1>;
}
