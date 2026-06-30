"use client";

import { useRouter } from "next/navigation";

export function GestureShellButton({ href }: { href: string }) {
  const router = useRouter();

  return (
    <button
      data-testid="gesture-shell-navigation"
      onClick={() => {
        if (router.experimental_gesturePush === undefined) {
          throw new Error("experimental_gesturePush is unavailable");
        }
        router.experimental_gesturePush(href);
      }}
    >
      Gesture to partially static page
    </button>
  );
}
