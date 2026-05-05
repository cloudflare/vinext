// Fixture for classifyAppRoute integration test: revalidate=false → static.
// Next.js treats revalidate=false as "never revalidate" (fully static, cache indefinitely).
// Ported from Next.js: https://nextjs.org/docs/app/api-reference/file-conventions/route-segment-config
export const revalidate = false;

export default function RevalidateFalsePage() {
  return <p>revalidate-false</p>;
}
