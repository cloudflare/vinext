import {
  decryptActionBoundArgs as decryptBoundValue,
  encryptActionBoundArgs as encryptBoundValue,
} from "@vitejs/plugin-rsc/utils/encryption-runtime";

// Like Next.js (encryption.ts `encodeActionBoundArg`), an inline Server
// Action's closure captures are encrypted together with the action's id, so a
// ciphertext issued for one action cannot be replayed as another action's
// captures, even when both actions are reachable from the same page.
export function encryptActionBoundArgs(actionId: string, captures: unknown[]): Promise<string> {
  return encryptBoundValue([actionId, captures]);
}

export async function decryptActionBoundArgs(
  actionId: string,
  encrypted: string | PromiseLike<string>,
): Promise<unknown[]> {
  const payload = await decryptBoundValue(Promise.resolve(encrypted));
  if (!Array.isArray(payload) || payload[0] !== actionId || !Array.isArray(payload[1])) {
    throw new Error("Invalid Server Action payload: failed to decrypt.");
  }
  return payload[1];
}
