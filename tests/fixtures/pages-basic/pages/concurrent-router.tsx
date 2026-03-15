import { useRouter } from "next/router";

interface Props {
  ssrPathname: string;
  ssrQuery: Record<string, string | string[]>;
}

export default function ConcurrentRouterPage({ ssrPathname, ssrQuery }: Props) {
  const router = useRouter();

  return (
    <div>
      <p data-testid="ssr-pathname">{ssrPathname}</p>
      <p data-testid="ssr-query">{JSON.stringify(ssrQuery)}</p>
      <p data-testid="router-pathname">{router.pathname}</p>
    </div>
  );
}

export async function getServerSideProps(context: {
  resolvedUrl: string;
  query: Record<string, string | string[] | undefined>;
}) {
  await new Promise((r) => setTimeout(r, Math.random() * 10));
  return {
    props: {
      ssrPathname: context.resolvedUrl.split("?")[0],
      ssrQuery: context.query,
    },
  };
}
