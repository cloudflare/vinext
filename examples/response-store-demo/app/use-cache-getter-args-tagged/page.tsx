import { cacheLife, cacheTag } from "next/cache";
import { connection } from "next/server";

// Flight serializes a getter's value, so the Response Store regenerates this value by
// calling the function with the encoded argument. It stays fresh for a minute, so only
// revalidating its tag makes it stale within a test.
const input = {
  get id() {
    return "getter-args-tagged";
  },
};

async function getValue(value: { id: string }): Promise<string> {
  "use cache";
  cacheLife({ revalidate: 60, expire: 120 });
  cacheTag("getter-args-tagged");
  return `${value.id}:${crypto.randomUUID()}`;
}

export default async function UseCacheGetterArgsTaggedPage() {
  await connection();
  return <output data-testid="getter-args-tagged">{await getValue(input)}</output>;
}
