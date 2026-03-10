export async function generateStaticParams() {
  return [{ slug: "hello-world" }, { slug: "getting-started" }, { slug: "advanced-guide" }];
}

export async function generateMetadata({ params }: { params: { slug: string } }) {
  return {
    title: `Blog: ${params.slug}`,
    description: `Read about ${params.slug}`,
  };
}

export default function BlogPost({ params }: { params: { slug: string } }) {
  return (
    <main>
      <h1>Blog Post</h1>
      <p>Slug: {params.slug}</p>
    </main>
  );
}
