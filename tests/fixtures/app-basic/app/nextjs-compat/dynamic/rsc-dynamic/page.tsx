// No "use client" — this entire page is a React Server Component tree.
// Regression test for: https://github.com/cloudflare/vinext/pull/466
//
// Verifies that dynamic() works in a pure RSC context where React.lazy is
// unavailable. The dynamic() shim falls back to an async component so that
// the RSC renderer resolves it natively instead of calling React.lazy.
import { NextDynamicRscComponent } from "../dynamic-imports/dynamic-rsc";

export default function RscDynamicPage() {
  return (
    <div id="rsc-dynamic-content">
      <NextDynamicRscComponent />
    </div>
  );
}
