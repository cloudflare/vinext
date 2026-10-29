import { Suspense } from "react";
import { countServerWork } from "../../../../lib/counters";
import { Greeting } from "../../greeting";

export async function generateStaticParams() {
  countServerWork("gsp-slug");
  return [{ slug: "known" }];
}

async function Slug({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <p id="slug">{slug}</p>;
}

export default function BlogPage({ params }: { params: Promise<{ slug: string }> }) {
  return (
    <main>
      <h1 id="title">Blog</h1>
      <Suspense fallback={<p id="slug-loading">Loading slug…</p>}>
        <Slug params={params} />
      </Suspense>
      <Suspense fallback={<p id="greeting-loading">Loading greeting…</p>}>
        <Greeting />
      </Suspense>
    </main>
  );
}
