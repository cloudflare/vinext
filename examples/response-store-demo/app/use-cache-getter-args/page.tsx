import { cacheLife, cacheTag } from "next/cache";
import { connection } from "next/server";

// Flight serializes a getter's value like any other property, so the Response Store
// regenerates these values by calling the functions with the encoded arguments, not by
// replaying this page.
const input = {
  get id() {
    return "getter-args";
  },
};

async function getFirst(value: { id: string }): Promise<string> {
  "use cache";
  cacheLife({ revalidate: 1, expire: 2 });
  cacheTag("getter-args-first");
  return `first:${value.id}:${crypto.randomUUID()}`;
}

async function getSecond(value: { id: string }): Promise<string> {
  "use cache";
  cacheLife({ revalidate: 1, expire: 2 });
  return `second:${value.id}:${crypto.randomUUID()}`;
}

export default async function UseCacheGetterArgsPage() {
  await connection();
  return (
    <>
      <output data-testid="getter-args-first">{await getFirst(input)}</output>
      <output data-testid="getter-args-second">{await getSecond(input)}</output>
    </>
  );
}
