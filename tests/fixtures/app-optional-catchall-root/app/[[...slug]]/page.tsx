export default async function CatchAllPage({ params }: { params: Promise<{ slug?: string[] }> }) {
  const { slug } = await params;
  const isEmpty = slug === undefined || (Array.isArray(slug) && slug.length === 0);
  return (
    <>
      <p id="slug-value">{isEmpty ? "__EMPTY__" : slug!.join("/")}</p>
      <p id="slug-type">
        {slug === undefined ? "undefined" : Array.isArray(slug) ? "array" : typeof slug}
      </p>
      <p id="slug-length">{slug ? slug.length : 0}</p>
    </>
  );
}
