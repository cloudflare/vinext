"use client";

export default function DynamicLoadingError({ error }: { error: Error }) {
  return <p id="dynamic-error-boundary">{error.message}</p>;
}
