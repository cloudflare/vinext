import Link from "next/link";
import { AboutRefreshButton } from "./refresh-button";

export default function AboutPage() {
  return (
    <main>
      <h1 id="app-page">About</h1>
      <p>This is the about page.</p>
      <AboutRefreshButton />
      <Link href="/">Back to Home</Link>
    </main>
  );
}
