import { randomUUID } from "node:crypto";

export const revalidate = 60;

// The Cache Components prelude must synchronize Node builtin wrappers before
// a user module can capture a named export during ESM evaluation.
const moduleScopedRandomUuid = randomUUID;

export default function NodeCryptoAliasPage() {
  return <main>node crypto alias: {moduleScopedRandomUuid()}</main>;
}
