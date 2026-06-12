"use server";

export async function fromServerBoundary() {
  "use cache";
  return "server-boundary";
}
