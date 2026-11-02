import Link from "next/link";
import { EffectProbe } from "../../../effect-probe";

export default async function NotesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <>
      <h2>Notes {id}</h2>
      <EffectProbe name={`notes:${id}`} />
      <Link href="/bfcache-effects/rooms/a/notes">Notes a</Link>{" "}
      <Link href="/bfcache-effects/rooms/b/notes">Notes b</Link>
    </>
  );
}
