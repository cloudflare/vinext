import Link from "next/link";
import { Refresher } from "./refresher";

export default function RefreshDuringNavigationPollingPage() {
  return (
    <>
      <Refresher />
      <h1 id="polling-page">Polling</h1>
      <Link href="/refresh-during-navigation/slow" id="slow-link">
        Slow page
      </Link>
    </>
  );
}
