import Link from "next/link";
export const metadata = { title: "Blog" };
const posts = Array.from({ length: 25 }, (_, i) => ({
  slug: `post-${i + 1}`,
  title: `Blog Post ${i + 1}: ${["React Patterns", "Server Components", "Caching", "Deployment", "Performance"][i % 5]}`,
  date: new Date(2025, 0, i + 1).toLocaleDateString(),
}));
export default function BlogPage() {
  return (
    <div>
      <h1>Blog</h1>
      {posts.map(post => (
        <article key={post.slug} style={{ marginBottom: "1rem", paddingBottom: "1rem", borderBottom: "1px solid #eee" }}>
          <Link href={`/blog/${post.slug}`}><h2>{post.title}</h2></Link>
          <time>{post.date}</time>
        </article>
      ))}
    </div>
  );
}

