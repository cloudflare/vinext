import Link from "next/link";
import "./global.css";

export default function HashScrollCssIsolationWithOffsetPage() {
  return (
    <main>
      <h1>Hash Scroll CSS Isolation With Offset</h1>
      <Link href="#target" id="link-to-target">
        To target
      </Link>
      <div style={{ height: 1200 }} />
      <section id="target">Target</section>
      <div style={{ height: 800 }} />
    </main>
  );
}
