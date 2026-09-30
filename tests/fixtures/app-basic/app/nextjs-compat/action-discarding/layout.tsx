import Link from "next/link";
import type { ReactNode } from "react";
import { getValue } from "./state";
import { ActionDiscardingValue } from "./client";

export const dynamic = "force-dynamic";

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <section>
      <p>
        Discarded action value: <ActionDiscardingValue value={getValue()} />
      </p>
      <Link id="navigate-discard-destination" href="/nextjs-compat/action-discarding/destination">
        Navigate to destination
      </Link>
      {children}
    </section>
  );
}
