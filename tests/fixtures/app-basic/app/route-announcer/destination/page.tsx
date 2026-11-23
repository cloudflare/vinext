import Link from "next/link";

export const metadata = { title: "Route Announcer Destination" };

export default function RouteAnnouncerDestinationPage() {
  return (
    <main>
      <h1>Route Announcer Destination</h1>
      <Link href="/route-announcer" id="to-start">
        Back to start
      </Link>
    </main>
  );
}
