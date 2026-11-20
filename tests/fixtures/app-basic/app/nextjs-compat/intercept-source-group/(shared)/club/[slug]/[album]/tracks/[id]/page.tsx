export default async function TrackPage({
  params,
}: {
  params: Promise<{ slug: string; album: string; id: string }>;
}) {
  const { slug, album, id } = await params;
  return (
    <p id="intercept-source-group-track">
      Track page: {slug} {album} {id}
    </p>
  );
}
