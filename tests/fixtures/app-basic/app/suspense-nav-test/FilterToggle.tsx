"use client";
import { useRouter } from "next/navigation";

export function FilterToggle({ current }: { current: string }) {
  const router = useRouter();
  return (
    <button
      id="toggle-filter"
      onClick={() =>
        router.push(current ? "/suspense-nav-test" : "/suspense-nav-test?filter=active")
      }
    >
      {current ? "Clear filter" : "Apply filter"}
    </button>
  );
}
