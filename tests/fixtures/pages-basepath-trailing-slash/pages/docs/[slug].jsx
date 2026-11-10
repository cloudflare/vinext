// A route whose first segment repeats the basePath: its URLs are
// /docs/docs/<slug>/, and middleware must see /docs/<slug>/.
export function getServerSideProps({ params }) {
  return { props: { slug: params.slug } };
}

export default function DocsPage({ slug }) {
  return <h1 id="docs-page">docs {slug}</h1>;
}
