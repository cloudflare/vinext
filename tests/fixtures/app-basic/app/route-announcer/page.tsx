import Link from "next/link";

export const metadata = { title: "Route Announcer Start" };

export default function RouteAnnouncerStartPage() {
  return (
    <main>
      <h1>Route Announcer Start</h1>
      <Link href="/route-announcer/destination" id="to-destination">
        Go to destination
      </Link>
    </main>
  );
}
