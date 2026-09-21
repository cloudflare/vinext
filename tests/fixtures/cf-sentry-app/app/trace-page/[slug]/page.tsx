import * as Sentry from "@sentry/nextjs";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function TracePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return Sentry.startSpan(
    {
      attributes: { "fixture.router": "app-page", "fixture.slug": slug },
      name: "fixture.app.page.child",
      op: "fixture.page",
    },
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return (
        <main>
          Traced App Page: {slug}
          <Link href={`/trace-page/${slug}-next`}>Navigate within trace fixture</Link>
        </main>
      );
    },
  );
}
