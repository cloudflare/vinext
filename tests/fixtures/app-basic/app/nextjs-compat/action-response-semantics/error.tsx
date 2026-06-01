"use client";

export default function Error({ error }: { error: Error }) {
  return <h2 id="action-error">{error.message}</h2>;
}
