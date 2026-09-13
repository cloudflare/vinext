export async function getStaticProps() {
  return { props: { value: "pages-config-header" }, revalidate: 60 };
}

export default function PagesConfigHeader({ value }: { value: string }) {
  return <p id="cacheability-result">{value}</p>;
}
