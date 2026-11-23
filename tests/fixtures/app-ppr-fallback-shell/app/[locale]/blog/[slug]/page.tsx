import { Suspense } from "react";

export function generateStaticParams() {
  return [{ locale: "en", slug: "hello" }];
}

async function Slug({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <p id="slug">{slug}</p>;
}

export default function Page({ params }: { params: Promise<{ slug: string }> }) {
  return (
    <main>
      <h1 id="shell">static shell</h1>
      <Suspense fallback={<p id="slug-loading">loading</p>}>
        <Slug params={params} />
      </Suspense>
    </main>
  );
}
