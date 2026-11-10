"use client";

import { useParams } from "next/navigation";

// Shows the params useParams() returns where it renders.
export function ParamsProbe({ name }: { name: string }) {
  return <p data-testid={`params-${name}`}>{JSON.stringify(useParams())}</p>;
}
