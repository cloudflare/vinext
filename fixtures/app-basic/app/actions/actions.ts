"use server";

import { redirect } from "next/navigation";

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

/**
 * Server action that calls redirect() — should result in a redirect response.
 */
export async function redirectAction(): Promise<void> {
  redirect("/about");
}

/**
 * Server action that throws a regular error.
 */
export async function errorAction(): Promise<string> {
  throw new Error("Action failed intentionally");
}

/**
 * Server action that returns complex data (object, array, Date).
 */
export async function complexDataAction(): Promise<{
  items: string[];
  count: number;
  nested: { key: string };
}> {
  return {
    items: ["alpha", "beta", "gamma"],
    count: 3,
    nested: { key: "value" },
  };
}

/**
 * Server action for useActionState — accepts previous state and formData,
 * returns new state. This is the idiomatic Next.js 15+ pattern.
 */
export async function counterAction(
  prevState: { count: number },
  formData: FormData,
): Promise<{ count: number }> {
  const action = formData.get("action") as string;
  if (action === "increment") {
    return { count: prevState.count + 1 };
  }
  if (action === "decrement") {
    return { count: prevState.count - 1 };
  }
  return prevState;
}
