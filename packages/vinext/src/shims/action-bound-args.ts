import {
  decryptActionBoundArgs,
  encryptActionBoundArgs,
} from "@vitejs/plugin-rsc/utils/encryption-runtime";

// Like Next.js (encryption.ts), an inline Server Action's encrypted closure
// names the action it was bound to and only decrypts for that action.
// plugin-rsc's encryption authenticates the captures but not their action, so
// on its own a same-route action's closure would decrypt as this action's.
//
// The sealed value is an object: plugin-rsc's own closures (e.g. sealed under a
// persisted `defineEncryptionKey` by an earlier deployment) are always arrays,
// and vinext's "use cache" envelopes are strings, so neither can pass as one.
type BoundArgs = { actionId: string; captures: unknown[] };

export function encryptBoundArgs(actionId: string, captures: unknown[]): Promise<string> {
  return encryptActionBoundArgs({ actionId, captures } satisfies BoundArgs);
}

export async function decryptBoundArgs(
  actionId: string,
  encrypted: ReturnType<typeof encryptActionBoundArgs>,
): Promise<unknown[]> {
  const payload = (await decryptActionBoundArgs(encrypted)) as Partial<BoundArgs> | null;
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload) ||
    payload.actionId !== actionId ||
    !Array.isArray(payload.captures)
  ) {
    throw new Error("Invalid Server Action payload: failed to decrypt.");
  }
  return payload.captures;
}
