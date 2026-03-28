// No "use client" — this entire page is a React Server Component tree.
// Regression test for: https://github.com/cloudflare/vinext/pull/466
//
// Verifies that dynamic() works in a pure RSC context. Currently React.lazy
// is available in react-server, so the standard lazy path handles this.
// The async fallback path (for future React versions that strip lazy from
// react-server) is tested in tests/dynamic.test.ts via React.lazy stubbing.
import { NextDynamicRscComponent } from "../dynamic-imports/dynamic-rsc";

export default function RscDynamicPage() {
  return (
    <div id="rsc-dynamic-content">
      <NextDynamicRscComponent />
    </div>
  );
}
