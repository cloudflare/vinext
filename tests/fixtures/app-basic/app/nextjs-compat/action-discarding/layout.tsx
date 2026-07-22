import Link from "next/link";
import type { ReactNode } from "react";
import { getValue } from "./state";

export const dynamic = "force-dynamic";

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <section>
      <p>
        Discarded action value: <span id="discarded-action-value">{getValue()}</span>
      </p>
      <Link id="navigate-discard-destination" href="/nextjs-compat/action-discarding/destination">
        Navigate to destination
      </Link>
      {children}
    </section>
  );
}
