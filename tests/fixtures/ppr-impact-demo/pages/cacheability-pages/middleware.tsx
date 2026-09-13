export async function getStaticProps() {
  return { props: { value: "pages-middleware" }, revalidate: 60 };
}

export default function PagesMiddleware({ value }: { value: string }) {
  return <p id="cacheability-result">{value}</p>;
}
