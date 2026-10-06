import Link from "next/link";
import type { ReactNode } from "react";

// The render ID comes from this server layout, so a stored page keeps it and a
// fresh render changes it.
export default function ClientSearchParamsLayout({ children }: { children: ReactNode }) {
  const renderId = crypto.randomUUID();

  return (
    <main>
      <nav className="crumbs">
        <Link prefetch={false} href="/">&larr; Demo home</Link>
      </nav>
      {children}
      <div className="timestamp">
        <p>
          Render ID: <code data-testid="client-search-render-id">{renderId}</code>
        </p>
      </div>
    </main>
  );
}
