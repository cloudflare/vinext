import * as Sentry from "@sentry/nextjs";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return Sentry.startSpan(
    {
      attributes: { "fixture.slug": slug },
      name: "fixture.app.metadata.child",
      op: "fixture.metadata",
    },
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { title: `Traced metadata: ${slug}` };
    },
  );
}

export default async function TraceMetadataPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <main>Traced metadata for {slug}</main>;
}
