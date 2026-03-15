export async function generateStaticParams() {
  return [{ slug: "hello-world" }, { slug: "getting-started" }];
}

export default async function BlogPost({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return (
    <main>
      <h1 data-testid="blog-title">Blog: {slug}</h1>
      <p data-testid="blog-slug">Slug: {slug}</p>
      <a href="/">Back to home</a>
    </main>
  );
}
