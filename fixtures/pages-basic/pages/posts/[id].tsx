import { useRouter } from "next/router";

interface PostProps {
  id: string;
}

export default function Post({ id }: PostProps) {
  const router = useRouter();

  return (
    <div>
      <h1 data-testid="post-title">Post: {id}</h1>
      <p data-testid="pathname">Pathname: {router.pathname}</p>
      <p data-testid="query">Query ID: {router.query.id}</p>
    </div>
  );
}

export async function getServerSideProps({ params }: { params: { id: string } }) {
  return {
    props: {
      id: params.id,
    },
  };
}
