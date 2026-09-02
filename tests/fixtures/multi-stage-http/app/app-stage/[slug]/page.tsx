import { draftMode } from "next/headers";

export const revalidate = 60;

export default async function AppStagePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const isDraftMode = (await draftMode()).isEnabled;
  const renderToken = crypto.randomUUID();
  return (
    <main data-draft-mode={String(isDraftMode)} data-render-token={renderToken} data-slug={slug}>
      App HTTP stage render-token:{renderToken}
    </main>
  );
}
