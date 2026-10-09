import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";

// The server renders this dynamic() component, and the client preloads it
// before hydrating, so its useId() value must match the server's.
const UseIdField = dynamic(() => import("../../components/next-dynamic/use-id-field"));

export default function NextDynamicUseIdPage() {
  // Like Next.js's LoadableComponent, a ref gets the `{ retry }` handle.
  const loadableRef = useRef<{ retry?: unknown } | null>(null);
  const [hasRetry, setHasRetry] = useState(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- reads the ref after mount
    setHasRetry(typeof loadableRef.current?.retry === "function");
    // An update right after hydration, before a component that hydrated
    // without its module could load, makes React client-render it.
    // oxlint-disable-next-line react/set-state-in-effect -- marks the mount
    setMounted(true);
  }, []);
  return (
    <div>
      <h1>next/dynamic useId</h1>
      <UseIdField ref={loadableRef} />
      <p id="dynamic-ref-retry">{hasRetry ? "retry" : "none"}</p>
      <p id="dynamic-use-id-mounted">{mounted ? "mounted" : "server"}</p>
    </div>
  );
}
