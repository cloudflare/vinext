import Link from "next/link";

// Used by E2E: app-router/multiple-root-layouts.spec.ts. Without app/layout,
// Next.js renders this not-found in its default layout.
export default function AppNotFound() {
  return (
    <>
      <p id="app-not-found">app not found</p>
      <Link href="/closed/listed" id="to-site">
        Listed
      </Link>
    </>
  );
}
