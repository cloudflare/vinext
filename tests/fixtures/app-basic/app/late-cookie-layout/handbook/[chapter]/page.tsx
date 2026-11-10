export const dynamicParams = false;

export async function generateStaticParams() {
  return [{ chapter: "welcome" }];
}

export default async function HandbookChapterPage({
  params,
}: {
  params: Promise<{ chapter: string }>;
}) {
  const { chapter } = await params;
  return <h1>Chapter {chapter}</h1>;
}
