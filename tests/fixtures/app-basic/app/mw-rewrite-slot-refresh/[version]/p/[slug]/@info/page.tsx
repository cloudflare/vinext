import { revalidateRewrittenPage } from "../actions";

export default async function InfoPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return (
    <>
      <p id="mw-rewrite-slot-refresh-info">info {slug}</p>
      <form action={revalidateRewrittenPage}>
        <button id="mw-rewrite-slot-refresh-action" type="submit">
          Revalidate
        </button>
      </form>
    </>
  );
}
