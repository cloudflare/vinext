import Link from "next/link";

// Used by Playwright: app-router/hmr-suspense-scroll.spec.ts edits this marker
// to push an RSC update.
export default async function HmrSuspenseScrollPage() {
  await new Promise((resolve) => setTimeout(resolve, 1000));

  return (
    <main>
      <Link href="/hmr-suspense-scroll/target" data-testid="hmr-suspense-scroll-link">
        Target
      </Link>
      <p data-testid="hmr-suspense-scroll-marker">before edit</p>
      {Array.from({ length: 300 }, (_, index) => (
        <p key={index} style={{ height: 40, margin: 0 }}>
          Row {index}
        </p>
      ))}
    </main>
  );
}
