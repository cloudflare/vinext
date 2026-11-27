import Link from "next/link";

// An intercepting route with a dynamic folder of the slot above its marker.
export default async function TrackModal({
  params,
}: {
  params: Promise<{ slug: string; album: string; id: string }>;
}) {
  const { slug, album, id } = await params;
  return (
    <>
      <p id="intercept-source-group-track-modal">
        Track modal: {slug} {album} {id}
      </p>
      <Link href="/nextjs-compat/intercept-source-group/club/acme/two/tracks/2">Track 2</Link>
    </>
  );
}
