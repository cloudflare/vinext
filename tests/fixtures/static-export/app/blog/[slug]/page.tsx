export async function generateStaticParams() {
  return [{ slug: "hello-world" }, { slug: "getting-started" }, { slug: "advanced-guide" }];
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return { title: `Blog: ${slug}` };
}

export default async function BlogPost({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return (
    <main>
      <h1>Blog Post</h1>
      <p>Slug: {slug}</p>
    </main>
  );
}
