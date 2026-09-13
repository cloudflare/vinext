export async function getServerSideProps({
  res,
}: {
  res: { setHeader(name: string, value: string): void };
}) {
  res.setHeader("Cache-Control", "public, s-maxage=36");
  return { props: { value: "pages-gssp-public" } };
}

export default function PagesGsspPublic({ value }: { value: string }) {
  return <p id="cacheability-result">{value}</p>;
}
