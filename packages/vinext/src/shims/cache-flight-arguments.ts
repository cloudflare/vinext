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

/**
 * Supplied to Flight per encodeReply call by the cache codec integration.
 * Native FormData assigns wall-clock timestamps to Blob wrappers. Give only
 * those wrappers a deterministic timestamp; actual File metadata is preserved.
 */
export class CacheFlightFormData extends FormData {
  static override [Symbol.hasInstance](value: unknown): boolean {
    return value instanceof FormData;
  }
  override append(name: string, value: string | Blob, filename?: string): void {
    if (value instanceof Blob) {
      if (!(value instanceof File)) {
        value = new File([value], "blob", { type: blobType.call(value), lastModified: 0 });
      }
      if (filename !== undefined) super.append(name, value, filename);
      else super.append(name, value);
    } else {
      super.append(name, value);
    }
  }
}

/** Snapshot only the multipart transport, never traverse user arguments. */
export async function snapshotFlightReply(
  reply: string | FormData,
  pagePropsIndex?: number,
): Promise<CacheFlightArguments> {
  if (typeof reply === "string") return { version: 1, reply, pagePropsIndex };
  if (!CacheFlightFormData.prototype.isPrototypeOf(reply)) {
    throw new Error("vinext: use cache requires the Flight FormData integration");
  }
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

export async function flightArgumentsKey(args: CacheFlightArguments): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(args)),
  );
  return Buffer.from(hash).toString("base64url");
}
