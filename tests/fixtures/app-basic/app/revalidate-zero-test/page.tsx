// Fixture for classifyAppRoute integration test: revalidate=0 → ssr.
// Next.js treats revalidate=0 as "revalidate on every request" (SSR).
export const revalidate = 0;

export default function RevalidateZeroPage() {
  return <p>revalidate-zero</p>;
}
