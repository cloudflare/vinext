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
    //
    // Mechanically, this fixture exercises a different runtime path than
    // upstream. Upstream's gesturePush forks an optimistic, discardable router
    // state (FreshnessPolicy.Gesture) without touching history; the URL only
    // lands when the held push() below resolves. vinext's
    // experimental_gesturePush instead performs a real RSC navigation that
    // commits to history synchronously, so the canonical push() below
    // navigates to the same URL a second time. The observable contract the
    // spec asserts (target visible + URL updated mid-gesture) is identical
    // either way, and the second push leaves no duplicate history entry:
    // commitNavigationHistory (app-browser-history-controller.ts) skips the
    // history write when the committed URL already equals the target, so a
    // back traversal after the gesture lands on the home page, not on
    // target-page twice.
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
