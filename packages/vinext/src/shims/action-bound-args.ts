import {
  decryptActionBoundArgs,
  encryptActionBoundArgs,
} from "@vitejs/plugin-rsc/utils/encryption-runtime";

// Like Next.js (encryption.ts), an inline Server Action's encrypted closure
// names the action it was bound to and only decrypts for that action.
// plugin-rsc's encryption authenticates the captures but not their action, so
// on its own a same-route action's closure would decrypt as this action's.

export function encryptBoundArgs(actionId: string, captures: unknown[]): Promise<string> {
  return encryptActionBoundArgs([actionId, captures]);
}

export async function decryptBoundArgs(
  actionId: string,
  encrypted: ReturnType<typeof encryptActionBoundArgs>,
): Promise<unknown[]> {
  const payload = await decryptActionBoundArgs(encrypted);
  if (!Array.isArray(payload) || payload[0] !== actionId || !Array.isArray(payload[1])) {
    throw new Error("Invalid Server Action payload: failed to decrypt.");
  }
  return payload[1];
}
