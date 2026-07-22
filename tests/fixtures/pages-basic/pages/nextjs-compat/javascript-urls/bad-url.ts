// Ported from Next.js: test/e2e/app-dir/javascript-urls/bad-url.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/javascript-urls/bad-url.ts
export const DANGEROUS_JAVASCRIPT_URL =
  "javascript:window.location.assign('/nextjs-compat/javascript-urls/boom');";
