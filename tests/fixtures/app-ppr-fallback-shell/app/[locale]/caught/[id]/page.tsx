async function getCachedValue(id: string) {
  "use cache";
  throw new Error(`Caught cached value for ${id}`);
}

export function generateStaticParams() {
  return [{ id: "static" }];
}

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    await getCachedValue(id);
  } catch {
    return <p id="caught-cache-fallback">fallback for {id}</p>;
  }
}
