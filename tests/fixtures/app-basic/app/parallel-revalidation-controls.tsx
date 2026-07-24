"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { revalidateParallelSlots } from "./parallel-revalidation-actions";

export function RefreshControl() {
  const router = useRouter();
  return <button onClick={() => router.refresh()}>Refresh</button>;
}

export function RevalidateControl() {
  return <button onClick={() => revalidateParallelSlots()}>Revalidate</button>;
}

export function SerializedRevalidateControl() {
  const [status, setStatus] = useState("idle");
  return (
    <>
      <button
        aria-label="Run serialized revalidation"
        data-testid="serialized-revalidate"
        onClick={async () => {
          await revalidateParallelSlots("A");
          setStatus("A resolved");
          await revalidateParallelSlots("B");
          setStatus("B resolved");
        }}
      >
        Revalidate twice
      </button>
      <p data-testid="serialized-revalidate-status">{status}</p>
    </>
  );
}

export function SearchParamsControl({ id, random }: { id: string; random?: string }) {
  const router = useRouter();
  return (
    <div>
      <p data-testid={`${id}-search-params`}>Params: {JSON.stringify(random)}</p>
      <button onClick={() => router.replace(`?random=${Math.random()}#hash-test`)}>
        Update {id} search params
      </button>
    </div>
  );
}
