import type { GetServerSidePropsResult, GetServerSidePropsContext } from "next";
import Link from "next/link";

interface PostProps {
  id: string;
  title: string;
}

export async function getServerSideProps(
  ctx: GetServerSidePropsContext,
): Promise<GetServerSidePropsResult<PostProps>> {
  const id = ctx.params?.id as string;
  return {
    props: {
      id,
      title: `Post ${id}`,
    },
  };
}

export default function PostPage({ id, title }: PostProps) {
  return (
    <>
      <h1 data-testid="post-title">{title}</h1>
      <p data-testid="post-id">ID: {id}</p>
      <nav>
        <Link href="/">Home</Link>
        {" | "}
        <Link href="/posts/other">Other Post</Link>
      </nav>
    </>
  );
}
