import { NestedReader } from "./client";

export const dynamic = "force-dynamic";

// Reads a nested unstable_cache from a Server Action.
export default async function ActionNestedUnstableCachePage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string }>;
}) {
  const { id = "" } = await searchParams;
  return (
    <main>
      <h1>Action Nested unstable_cache</h1>
      <NestedReader id={id} />
    </main>
  );
}
