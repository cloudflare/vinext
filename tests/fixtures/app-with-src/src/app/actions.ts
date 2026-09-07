"use server";

export async function roundTripAction(value: string): Promise<string> {
  return `server-action:${value}`;
}
