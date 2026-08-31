export async function getStaticProps() {
  return { props: {}, revalidate: 300 };
}

export default function PagesPrewarmTarget() {
  return <h1>Pages prewarm target</h1>;
}
