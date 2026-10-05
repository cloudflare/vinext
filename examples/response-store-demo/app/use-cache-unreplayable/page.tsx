import { cacheLife } from "next/cache";
import { connection } from "next/server";

// A getter keeps the arguments from being replayed, so the Response Store can't call these
// functions to regenerate them. It regenerates each value by replaying this page instead,
// and the page reads the other value too.
const input = {
  get id() {
    return "unreplayable";
  },
};

async function getFirst(value: { id: string }): Promise<string> {
  "use cache";
  cacheLife({ revalidate: 1, expire: 2 });
  return `first:${value.id}:${crypto.randomUUID()}`;
}

async function getSecond(value: { id: string }): Promise<string> {
  "use cache";
  cacheLife({ revalidate: 1, expire: 2 });
  return `second:${value.id}:${crypto.randomUUID()}`;
}

export default async function UseCacheUnreplayablePage() {
  await connection();
  return (
    <>
      <output data-testid="unreplayable-first">{await getFirst(input)}</output>
      <output data-testid="unreplayable-second">{await getSecond(input)}</output>
    </>
  );
}
