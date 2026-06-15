export default async function PostPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  return <h1 id={`post-${id}-page`}>Post {id}</h1>;
}
