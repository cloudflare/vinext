import * as Sentry from "@sentry/nextjs";

export const dynamic = "force-static";
export const revalidate = 60;

export function generateStaticParams() {
  return [];
}

export default async function TraceStaticPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return Sentry.startSpan(
    {
      attributes: { "fixture.router": "app-page-static", "fixture.slug": slug },
      name: "fixture.app.static-page.child",
      op: "fixture.page",
    },
    () => <main>Traced static App Page: {slug}</main>,
  );
}
