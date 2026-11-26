import Link from "next/link";

// An empty title overrides the root layout's, so the page has no document
// title and the announcer falls back to the first h1.
export const metadata = { title: "" };

export default function RouteAnnouncerUntitledPage() {
  return (
    <main>
      <h1>Route Announcer Untitled Heading</h1>
      <Link href="/route-announcer/untitled/no-heading" id="to-no-heading">
        Go to the page with no heading
      </Link>
    </main>
  );
}
