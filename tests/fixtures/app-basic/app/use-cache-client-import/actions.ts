"use cache";

export async function getCachedMessage(value: string) {
  return `client-cache:${value}:${Math.random()}`;
}

export async function getUncachedMessage(value: string) {
  "use server";
  return `client-server:${value}:${Math.random()}`;
}
