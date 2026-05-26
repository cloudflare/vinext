"use client";

import { startTransition, useEffect } from "react";
import { useRouter } from "next/navigation";

type RouterAutoscrollControls = {
  push: (href: string) => void;
  pushThenRefresh: (href: string) => void;
  pushNoScroll: (href: string) => void;
  refresh: () => void;
};

declare global {
  interface Window {
    __vinextRouterAutoscroll?: RouterAutoscrollControls;
  }
}

export function RouterAutoscrollControls() {
  const router = useRouter();

  useEffect(() => {
    const controls: RouterAutoscrollControls = {
      push: (href) => router.push(href),
      pushThenRefresh: (href) => {
        startTransition(() => {
          router.push(href);
          router.refresh();
        });
      },
      pushNoScroll: (href) => router.push(href, { scroll: false }),
      refresh: () => router.refresh(),
    };
    window.__vinextRouterAutoscroll = controls;

    return () => {
      if (window.__vinextRouterAutoscroll === controls) {
        delete window.__vinextRouterAutoscroll;
      }
    };
  }, [router]);

  return null;
}
