"use server";

export async function measureAction(payload: string): Promise<number> {
  return payload.length;
}
