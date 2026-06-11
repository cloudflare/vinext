"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { startTransition, type ReactNode } from "react";

const pendingResolvers = new Set<() => void>();
const routeRoot = "/nextjs-compat/gesture-transitions";

export default function GestureTransitionsLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const isOnHomePage = pathname === routeRoot;

  const startGesture = (href: string) => {
    // Ported from Next.js: test/e2e/app-dir/gesture-transitions/app/layout.tsx
    // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/gesture-transitions/app/layout.tsx
    startTransition(async () => {
      if (router.experimental_gesturePush === undefined) {
        throw new Error("experimental_gesturePush is unavailable");
      }
      router.experimental_gesturePush(href);

      await new Promise<void>((resolve) => {
        pendingResolvers.add(resolve);
      });

      router.push(href);
    });
  };

  const endGesture = () => {
    for (const resolve of pendingResolvers) {
      resolve();
    }
    pendingResolvers.clear();
  };

  return (
    <>
      <header>
        <h1>Gesture Transitions Test</h1>
      </header>
      <nav>
        <Link href={`${routeRoot}/target-page`}>Link to target</Link>
        <button
          data-testid="start-gesture"
          disabled={!isOnHomePage}
          onClick={() => startGesture(`${routeRoot}/target-page`)}
        >
          Start Gesture
        </button>
        <button data-testid="end-gesture" onClick={endGesture}>
          End Gesture
        </button>
      </nav>
      <main>{children}</main>
    </>
  );
}
