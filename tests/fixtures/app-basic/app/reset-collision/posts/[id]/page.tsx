import { ErrorTrigger } from "../../error-trigger";

export default async function PostsCollisionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  return (
    <main>
      <h1 data-testid="posts-page">Posts {id}</h1>
      <ErrorTrigger label="posts" />
    </main>
  );
}
