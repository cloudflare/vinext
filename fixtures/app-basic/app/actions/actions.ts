"use server";

// Simple in-memory counter for testing server actions
let likeCount = 0;

export async function incrementLikes(): Promise<number> {
  likeCount++;
  return likeCount;
}

export async function getLikes(): Promise<number> {
  return likeCount;
}

export async function addMessage(formData: FormData): Promise<string> {
  const message = formData.get("message") as string;
  return `Received: ${message}`;
}
