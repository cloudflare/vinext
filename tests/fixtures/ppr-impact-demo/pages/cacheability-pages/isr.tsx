export async function getStaticProps() {
  return { props: { value: "pages-isr" }, revalidate: 60 };
}

export default function PagesIsr({ value }: { value: string }) {
  return <p id="cacheability-result">{value}</p>;
}
