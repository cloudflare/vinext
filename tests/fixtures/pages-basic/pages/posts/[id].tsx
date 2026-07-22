import { useRouter } from "next/router";

interface PostProps {
  id: string;
  query: Record<string, string | string[] | undefined>;
}

export default function Post({ id, query }: PostProps) {
  const router = useRouter();

  return (
    <div>
      <h1 data-testid="post-title">Post: {id}</h1>
      <p data-testid="pathname">Pathname: {router.pathname}</p>
      <p data-testid="as-path">As Path: {router.asPath}</p>
      <p data-testid="query">Query ID: {router.query.id}</p>
      <p data-testid="gssp-query">{JSON.stringify(query)}</p>
    </div>
  );
}

export async function getServerSideProps({
  params,
  query,
}: {
  params: { id: string };
  query: Record<string, string | string[] | undefined>;
}) {
  return {
    props: {
      id: params.id,
      query,
    },
  };
}
