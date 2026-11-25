import Link from "next/link";

export const metadata = { title: "Route Announcer Destination" };

export default function RouteAnnouncerDestinationPage() {
  return (
    <main>
      <h1>Route Announcer Destination</h1>
      <Link href="/route-announcer" id="to-start">
        Back to start
      </Link>
      <Link href="/route-announcer/destination?same=1" id="to-destination-again">
        Same title, another URL
      </Link>
      <Link href="/route-announcer/untitled" id="to-untitled">
        Go to the untitled page
      </Link>
    </main>
  );
}
