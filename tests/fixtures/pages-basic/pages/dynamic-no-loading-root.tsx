import React, { useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import dynamic from "next/dynamic";

// dynamic() without a loading option inside a separate client root, outside
// the page's React tree (e.g. a modal library's root).
const SlowDynamicContent = dynamic(
  () =>
    new Promise<typeof import("../components/slow-dynamic-content")>((resolve) => {
      setTimeout(() => resolve(import("../components/slow-dynamic-content")), 300);
    }),
);

function SeparateRootWidget() {
  return (
    <div>
      <p className="separate-root-static">Separate root static</p>
      <SlowDynamicContent label="Loaded in separate root" />
    </div>
  );
}

export default function DynamicNoLoadingRootPage() {
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = document.createElement("div");
    containerRef.current?.appendChild(el);
    const root = createRoot(el);
    root.render(<SeparateRootWidget />);
    return () => {
      setTimeout(() => {
        root.unmount();
        el.remove();
      });
    };
  }, []);
  return (
    <div>
      <h1>Dynamic Without Loading In A Separate Root</h1>
      <div ref={containerRef} />
    </div>
  );
}
