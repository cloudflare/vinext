"use client";

if (typeof window === "undefined") {
  await new Promise((resolve) => setTimeout(resolve, 100));
}

export function format(value: number): string {
  return `formatted:${value}`;
}
