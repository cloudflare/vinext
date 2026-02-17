/**
 * Next.js compat: not-found/basic — scoped not-found boundary for dynamic/[id]
 * Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/not-found/basic/app/dynamic/[id]/not-found.js
 */
export default function NotFound() {
  return <div id="not-found">{`dynamic/[id] not found`}</div>;
}
