"use client";

import Link, { useLinkStatus } from "next/link";

function PendingState({ id }: { id: string }) {
  const { pending } = useLinkStatus();
  return <span id={`${id}-status`}>{pending ? "pending" : "idle"}</span>;
}

export function StatusLink({ href, id, label }: { href: string; id: string; label: string }) {
  return (
    <Link href={href} id={id}>
      {label} <PendingState id={id} />
    </Link>
  );
}
