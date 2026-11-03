import { Suspense } from "react";

export const revalidate = 60;

// No path is generated at build, so each one renders on demand. A path
// starting with `throw-` throws inside Suspense after the shell. Next.js
// answers it with a 500 at runtime and stores nothing (and fails `next build`
// for a generated path), as it does for every ISR render that reports an error.
export function generateStaticParams() {
  return [];
}

async function Content({ slug }: { slug: string }) {
  await new Promise((resolve) => setTimeout(resolve, 50));
  if (slug.startsWith("throw-")) throw new Error("render-error fixture");
  return <p data-testid="render-error-content">resolved</p>;
}

export default async function RenderErrorPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const renderId = crypto.randomUUID();
  return (
    <main>
      <p>
        Render ID: <code data-render-id={renderId}>{renderId}</code>
      </p>
      <Suspense fallback={<p>loading</p>}>
        <Content slug={slug} />
      </Suspense>
    </main>
  );
}
