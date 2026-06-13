/**
 * Next.js compat: global-error/error-in-global-error — server component that
 * throws an error whose message instructs the shared `global-error.tsx` to
 * throw while rendering. Exercises the built-in fallback that Next.js renders
 * when `global-error.tsx` itself throws.
 * Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/global-error/error-in-global-error/error-in-global-error.test.ts
 */
export default function Page() {
  throw new Error("error in global error");
}
