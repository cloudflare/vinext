// No "use client" — this is a pure React Server Component.
// Regression test for: https://github.com/cloudflare/vinext/pull/466
//
// In the RSC environment, React.lazy may not be available in future React
// versions (the react-server condition could strip it). dynamic() has a
// defensive fallback to an async component pattern for that scenario.
// In React 19.x, React.lazy IS available in react-server, so this uses
// the standard LazyServer + Suspense path.
import dynamic from "next/dynamic";

export const NextDynamicRscComponent = dynamic(() => import("../text-dynamic-rsc"));
