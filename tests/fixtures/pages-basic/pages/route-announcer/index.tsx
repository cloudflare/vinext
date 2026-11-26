import Link from "next/link";

export default function RouteAnnouncerIndex() {
  return (
    <>
      <h1 id="route-announcer-index">Route Announcer Index</h1>
      <Link href="/route-announcer/page-with-title" id="page-with-title-link">
        Page with a title
      </Link>
      <Link href="/route-announcer/page-with-h1" id="page-with-h1-link">
        Page with an h1
      </Link>
      <Link href="/route-announcer/page-with-h1-and-title" id="page-with-h1-and-title-link">
        Page with an h1 and a title
      </Link>
      <Link href="/route-announcer/page-without-h1-or-title" id="page-without-h1-or-title-link">
        Page without an h1 or a title
      </Link>
    </>
  );
}
