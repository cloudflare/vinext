/**
 * Scoped forbidden boundary for dynamic/[id] segment.
 * Ported from: test/e2e/app-dir/forbidden/basic/app/dynamic/[id]/forbidden.js
 */
export default function Forbidden() {
  return <div id="forbidden">{`dynamic/[id] forbidden`}</div>;
}
