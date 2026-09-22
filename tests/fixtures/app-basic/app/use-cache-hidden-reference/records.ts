"use cache";

import "server-only";

const records: Record<string, { owner: string; secret: string }> = {
  victim: { owner: "victim", secret: "VICTIM_PRIVATE_RECORD" },
};

export async function readRecord(id: string) {
  return records[id] ?? null;
}
