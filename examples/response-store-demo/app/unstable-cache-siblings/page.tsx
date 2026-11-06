import { unstable_cache } from "next/cache";
import { connection } from "next/server";

// Two sibling entries on one page. Regenerating either one replays this page,
// which reads the other.
const readFirst = unstable_cache(
  async () => `first:${crypto.randomUUID()}`,
  ["response-store-sibling-first"],
  { revalidate: 1 },
);
const readSecond = unstable_cache(
  async () => `second:${crypto.randomUUID()}`,
  ["response-store-sibling-second"],
  { revalidate: 1 },
);

export default async function UnstableCacheSiblingsPage() {
  await connection();
  return (
    <>
      <output data-testid="sibling-first">{await readFirst()}</output>
      <output data-testid="sibling-second">{await readSecond()}</output>
    </>
  );
}
