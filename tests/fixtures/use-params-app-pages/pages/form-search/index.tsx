export async function getServerSideProps({ req }: { req: { url?: string } }) {
  const searchParams = new URL(req.url ?? "/", "http://localhost").searchParams;
  return {
    props: {
      query: searchParams.get("query"),
      source: searchParams.get("source"),
    },
  };
}

export default function FormSearchPage({
  query,
  source,
}: {
  query: string | null;
  source: string | null;
}) {
  return (
    <main style={{ minHeight: "200vh" }}>
      <div id="search-query">{query}</div>
      <div id="search-source">{source}</div>
    </main>
  );
}
