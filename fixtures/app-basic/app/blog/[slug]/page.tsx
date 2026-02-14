export default function BlogPost({
  params,
}: {
  params: { slug: string };
}) {
  return (
    <main>
      <h1>Blog Post</h1>
      <p>Slug: {params.slug}</p>
    </main>
  );
}
