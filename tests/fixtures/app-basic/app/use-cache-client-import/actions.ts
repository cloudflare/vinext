"use cache";

export async function getCachedMessage(value: string) {
  return `client-cache:${value}:${Math.random()}`;
}
