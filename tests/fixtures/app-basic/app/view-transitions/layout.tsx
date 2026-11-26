import Link from "next/link";
import { RouterPushTyped } from "./router-push-typed";

// View transitions on App Router navigations. The spec records every
// document.startViewTransition call React makes, with its transition types.
export default function ViewTransitionsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <nav>
        <Link href="/view-transitions/a" data-testid="vt-link-a">
          A
        </Link>{" "}
        <Link href="/view-transitions/b" data-testid="vt-link-b">
          B
        </Link>{" "}
        <Link
          href="/view-transitions/b"
          data-testid="vt-link-b-typed"
          transitionTypes={["nav-forward"]}
        >
          B (nav-forward)
        </Link>{" "}
        <Link href="/view-transitions/reveal" data-testid="vt-link-reveal">
          Reveal
        </Link>{" "}
        <RouterPushTyped />
      </nav>
      {children}
    </div>
  );
}
