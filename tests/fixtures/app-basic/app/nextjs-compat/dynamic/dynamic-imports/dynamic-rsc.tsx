// No "use client" — this is a pure React Server Component.
// Regression test for: https://github.com/cloudflare/vinext/pull/466
//
// In the RSC environment, React.lazy is not available (react-server condition
// strips it). dynamic() must fall back to the async component pattern so that
// the RSC renderer can resolve the import natively.
import dynamic from "next/dynamic";

export const NextDynamicRscComponent = dynamic(() => import("../text-dynamic-rsc"));
