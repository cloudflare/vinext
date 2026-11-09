"use server";

import { readNestedUnstableCache } from "../../../lib/nested-unstable-cache";

export async function readNested(id: string): Promise<string> {
  return (await readNestedUnstableCache(id)).nonce;
}
