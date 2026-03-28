"use client";

export function Button({ id, children }: { id?: string; children: React.ReactNode }) {
  return <button id={id}>{children}</button>;
}
