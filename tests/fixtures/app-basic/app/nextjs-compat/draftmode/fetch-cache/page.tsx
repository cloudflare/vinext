import { draftMode } from "next/headers";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ upstream?: string }>;
}) {
  const { upstream } = await searchParams;
  const token = upstream
    ? await fetch(upstream, { next: { revalidate: false, tags: ["draft-fetch-cache"] } }).then(
        (res) => res.text(),
      )
    : "";
  const { isEnabled } = await draftMode();

  return (
    <main>
      <p id="draft-mode">{String(isEnabled)}</p>
      <p id="token">{token}</p>
    </main>
  );
}
