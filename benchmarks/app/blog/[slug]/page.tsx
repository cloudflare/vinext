export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return { title: slug.replace(/-/g, " ") };
}
export default async function BlogPost({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const paragraphs = Array.from({ length: 5 }, (_, i) =>
    `Paragraph ${i + 1} of "${slug}". Lorem ipsum dolor sit amet, consectetur adipiscing elit.`
  );
  return (
    <div>
      <h1>{slug.replace(/-/g, " ")}</h1>
      <time>{new Date().toLocaleDateString()}</time>
      {paragraphs.map((p, i) => <p key={i}>{p}</p>)}
    </div>
  );
}

