interface SsrQueryProps {
  query: Record<string, string | string[] | undefined>;
  resolvedUrl: string;
}

export default function SsrQueryPage({ query, resolvedUrl }: SsrQueryProps) {
  return (
    <div>
      <h1>SSR Query</h1>
      <p data-testid="query">{JSON.stringify(query)}</p>
      <p data-testid="resolved-url">{resolvedUrl}</p>
    </div>
  );
}

export async function getServerSideProps(context: {
  query: Record<string, string | string[] | undefined>;
  resolvedUrl: string;
}) {
  return {
    props: {
      query: context.query,
      resolvedUrl: context.resolvedUrl,
    },
  };
}
