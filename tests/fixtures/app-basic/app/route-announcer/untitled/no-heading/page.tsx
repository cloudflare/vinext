import Link from "next/link";

// No document title and no h1: the announcer has nothing to announce, so it
// empties the region.
export const metadata = { title: "" };

export default function RouteAnnouncerNoHeadingPage() {
  return (
    <main>
      <p>Route Announcer No Heading</p>
      <Link href="/route-announcer" id="to-start">
        Back to start
      </Link>
    </main>
  );
}
