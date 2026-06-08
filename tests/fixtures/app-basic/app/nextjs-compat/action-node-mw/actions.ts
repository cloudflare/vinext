"use server";

/**
 * Server action used by the node-runtime-middleware regression test
 * (cloudflare/vinext#1480). The middleware in this fixture matches this
 * page's path and reads the request body before falling through; the action
 * POST must still be dispatched and able to read its own body.
 */
export async function echoAction(value: string): Promise<string> {
  return `echo:${value}`;
}
