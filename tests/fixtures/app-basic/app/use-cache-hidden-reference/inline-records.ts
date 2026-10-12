import "server-only";

export async function readInlineRecord(id: string) {
  "use cache";
  return id === "victim" ? { owner: "victim", secret: "VICTIM_INLINE_PRIVATE_RECORD" } : null;
}
