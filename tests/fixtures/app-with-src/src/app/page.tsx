import Link from "next/link";
import { isInitialized } from "../instrumentation-server";

export default function HomePage() {
  return (
    <>
      <h1 id="app-with-src-home">App With Src</h1>
      <p id="instrumentation-server-only">{String(isInitialized())}</p>
      <Link href="/dev-overlay-recovery" data-testid="link-to-recovery">
        Recovery
      </Link>
    </>
  );
}
