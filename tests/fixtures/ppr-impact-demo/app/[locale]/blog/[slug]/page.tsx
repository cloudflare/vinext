import { Suspense } from "react";
import { cookies } from "next/headers";

async function getBlogPost(locale: string, slug: string) {
  "use cache";
  if (slug !== "known") {
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  return { locale, slug, title: `Blog Post: ${slug}` };
}

async function BlogContent({ params }: { params: Promise<{ locale: string; slug: string }> }) {
  const { locale, slug } = await params;
  const post = await getBlogPost(locale, slug);
  return (
    <article id="blog-content">
      <h2>{post.title}</h2>
      <p>Locale: {post.locale}</p>
    </article>
  );
}

async function DynamicComments() {
  const cookieStore = await cookies();
  await new Promise((resolve) => setTimeout(resolve, 6_000));
  return (
    <section id="comments">Comments for {cookieStore.get("user")?.value ?? "anonymous"}</section>
  );
}

export function generateStaticParams() {
  return [{ slug: "known" }];
}

export default function Page({ params }: { params: Promise<{ locale: string; slug: string }> }) {
  return (
    <main>
      <div id="static-blog-header">Blog Article</div>
      <Suspense fallback={<div id="blog-loading">Loading article...</div>}>
        <BlogContent params={params} />
      </Suspense>
      <Suspense fallback={<div id="comments-loading">Loading comments...</div>}>
        <DynamicComments />
      </Suspense>
    </main>
  );
}
