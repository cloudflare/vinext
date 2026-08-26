export async function getServerSideProps() {
  return { props: { value: "pages-gssp" } };
}

export default function PagesGssp({ value }: { value: string }) {
  return <p id="cacheability-result">{value}</p>;
}
