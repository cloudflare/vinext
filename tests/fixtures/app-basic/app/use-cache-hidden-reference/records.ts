"use cache";

import "server-only";

const records: Record<string, { owner: string; secret: string }> = {
  victim: { owner: "victim", secret: "VICTIM_PRIVATE_RECORD" },
};

export default async function readDefaultRecord(id: string) {
  return records[id] ? { ...records[id], secret: "VICTIM_DEFAULT_PRIVATE_RECORD" } : null;
}

export async function readRecord(id: string) {
  return records[id] ?? null;
}
