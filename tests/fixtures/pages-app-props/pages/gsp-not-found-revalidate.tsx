// The custom App has getInitialProps, so the 404 is drawn under it.
export function getStaticProps() {
  return { notFound: true, revalidate: 60 };
}

export default function GspNotFoundRevalidatePage() {
  return <div id="page-content">never rendered</div>;
}
