"use client";

import Link from "next/link";
import { useRouter, useSelectedLayoutSegment } from "next/navigation";
import { Suspense, startTransition, useEffect, useRef } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { LayoutSegmentProvider } from "vinext/shims/layout-segment-context";

function ConcurrentSegmentValue() {
  return <span id="concurrentAuthSegment">{useSelectedLayoutSegment("auth")}</span>;
}

function ConcurrentRenderSuspender({ suspend }: { suspend: boolean }) {
  if (suspend) {
    (
      window as Window & { __vinextAbandonedSegmentRenderStarted?: boolean }
    ).__vinextAbandonedSegmentRenderStarted = true;
    throw new Promise(() => {});
  }

  return null;
}

function ConcurrentSegmentProbe() {
  const containerRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<Root | null>(null);

  function renderSegmentMap(segmentMap: Record<string, string[]>, suspend = false) {
    rootRef.current?.render(
      <Suspense fallback={<span>Suspended</span>}>
        <LayoutSegmentProvider segmentMap={segmentMap}>
          <ConcurrentSegmentValue />
        </LayoutSegmentProvider>
        <ConcurrentRenderSuspender suspend={suspend} />
      </Suspense>,
    );
  }

  useEffect(() => {
    const root = createRoot(containerRef.current!);
    rootRef.current = root;
    renderSegmentMap({ children: [], auth: ["visible"] });
    return () => {
      rootRef.current = null;
      root.unmount();
    };
  }, []);

  return (
    <section id="concurrentSegmentProbe">
      <button
        id="start-abandoned-segment-render"
        onClick={() => {
          startTransition(() => renderSegmentMap({ children: [], auth: ["abandoned"] }, true));
        }}
      >
        Start abandoned render
      </button>
      <button
        id="supersede-segment-render"
        onClick={() => flushSync(() => renderSegmentMap({ children: ["superseding"] }))}
      >
        Supersede render
      </button>
      <button
        id="later-default-only-render"
        onClick={() => flushSync(() => renderSegmentMap({ children: ["later"] }))}
      >
        Later default-only render
      </button>
      <div ref={containerRef} />
    </section>
  );
}

export default function Layout({
  children,
  auth,
  nav,
}: {
  children: React.ReactNode;
  auth: React.ReactNode;
  nav: React.ReactNode;
}) {
  const authSegment = useSelectedLayoutSegment("auth");
  const navSegment = useSelectedLayoutSegment("nav");
  const routeSegment = useSelectedLayoutSegment();
  const router = useRouter();

  return (
    <section>
      <nav>
        <Link href="/parallel-selected-segment">Main</Link>
        <Link href="/parallel-selected-segment/foo">Foo</Link>
        <button id="replace-foo" onClick={() => router.replace("/parallel-selected-segment/foo")}>
          Replace Foo
        </button>
        <Link href="/parallel-selected-segment/login">Login</Link>
        <Link href="/parallel-selected-segment/reset">Reset</Link>
        <Link href="/parallel-selected-segment/reset/withEmail">Reset with Email</Link>
        <Link href="/parallel-selected-segment/reset/withMobile">Reset with Mobile</Link>
      </nav>
      <div id="navSegment">navSegment (parallel route): {navSegment}</div>
      <div id="authSegment">authSegment (parallel route): {authSegment}</div>
      <div id="routeSegment">routeSegment (app route): {routeSegment}</div>
      <section id="navSlot">{nav}</section>
      <section id="authSlot">{auth}</section>
      <section id="children">{children}</section>
      <ConcurrentSegmentProbe />
    </section>
  );
}
