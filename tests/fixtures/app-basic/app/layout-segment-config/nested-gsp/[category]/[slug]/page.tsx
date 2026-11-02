import { recordPageCall } from "../../static-params-calls";

const slugsByCategory: Record<string, string> = {
  docs: "intro",
  guides: "start",
  reference: "api",
};

export function generateStaticParams({ params }: { params: { category?: string; slug?: string } }) {
  if (!params.category || !slugsByCategory[params.category] || params.slug !== undefined) {
    throw new Error("expected only parent category params");
  }
  recordPageCall(params.category);

  return [{ slug: slugsByCategory[params.category] }];
}

export default async function Page({
  params,
}: {
  params: Promise<{ category: string; slug: string }>;
}) {
  const { category, slug } = await params;
  return (
    <p data-testid="layout-segment-config-nested-gsp">
      Nested GSP {category}/{slug}
    </p>
  );
}
