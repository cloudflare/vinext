export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <h1 id="blog-post">Blog post {slug}</h1>;
}
