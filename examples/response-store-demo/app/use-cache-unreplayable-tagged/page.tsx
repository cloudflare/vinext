import { cacheLife, cacheTag } from "next/cache";
import { connection } from "next/server";

// A getter keeps the argument from being replayed, so the Response Store regenerates the
// value by replaying this page. It stays fresh for a minute, so only revalidating its tag
// makes it stale within a test.
const input = {
  get id() {
    return "unreplayable-tagged";
  },
};

async function getValue(value: { id: string }): Promise<string> {
  "use cache";
  cacheLife({ revalidate: 60, expire: 120 });
  cacheTag("unreplayable-tagged");
  return `${value.id}:${crypto.randomUUID()}`;
}

export default async function UseCacheUnreplayableTaggedPage() {
  await connection();
  return <output data-testid="unreplayable-tagged">{await getValue(input)}</output>;
}
