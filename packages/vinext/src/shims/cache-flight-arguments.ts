import { createHash } from "node:crypto";

/** The persisted argument transport. React owns the object graph and wire protocol. */
export type CacheFlightArguments = {
  version: 1;
  reply: string | ([string, string] | [string, string, string, number, string])[];
  pagePropsIndex?: number;
  layoutPropsIndex?: number;
};

// Native accessors are deliberately invoked with .call on the transported value.
/* oxlint-disable typescript/unbound-method */
const blobType = Object.getOwnPropertyDescriptor(Blob.prototype, "type")!.get!;
const fileName = Object.getOwnPropertyDescriptor(File.prototype, "name")!.get!;
const fileTime = Object.getOwnPropertyDescriptor(File.prototype, "lastModified")!.get!;
/* oxlint-enable typescript/unbound-method */

/** Snapshot only the multipart transport, never traverse user arguments. */
export async function snapshotFlightReply(
  reply: string | FormData,
  pagePropsIndex?: number,
): Promise<CacheFlightArguments> {
  if (typeof reply === "string") return { version: 1, reply, pagePropsIndex };
  const entries: Exclude<CacheFlightArguments["reply"], string> = [];
  for (const [name, value] of reply) {
    entries.push(
      typeof value === "string"
        ? [name, value]
        : [
            name,
            Buffer.from(await Blob.prototype.arrayBuffer.call(value)).toString("base64"),
            fileName.call(value),
            fileTime.call(value),
            blobType.call(value),
          ],
    );
  }
  return { version: 1, reply: entries, pagePropsIndex };
}

export function restoreFlightReply(args: CacheFlightArguments): string | FormData {
  if (typeof args.reply === "string") return args.reply;
  const reply = new FormData();
  for (const entry of args.reply) {
    const [name, data] = entry;
    // A new native File per occurrence strips decorations and makes identity
    // identical for the original invocation and a persisted replay.
    reply.append(
      name,
      entry.length === 2
        ? data
        : new File([Buffer.from(data, "base64")], entry[2], {
            lastModified: entry[3],
            type: entry[4],
          }),
    );
  }
  return reply;
}

/**
 * Like Next.js (use-cache-wrapper.ts, `encodeFormData`), a binary entry is keyed
 * by its bytes alone. Its name, type, and timestamp are replayed but not keyed:
 * native FormData gives each Blob wrapper a wall-clock timestamp.
 *
 * Hashed synchronously, as Next.js derives its key without leaving the task: a
 * cache hit must resolve before React flushes the shell, and an async digest
 * waits for a later event-loop turn.
 */
export function flightArgumentsKey(args: CacheFlightArguments): string {
  const reply =
    typeof args.reply === "string"
      ? args.reply
      : args.reply.map((entry) => (entry.length === 2 ? entry : [entry[0], { bytes: entry[1] }]));
  return createHash("sha256")
    .update(JSON.stringify({ ...args, reply }))
    .digest("base64url");
}
