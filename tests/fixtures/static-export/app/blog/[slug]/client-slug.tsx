"use client";

import { useParams } from "next/navigation";

export function ClientSlug() {
  const params = useParams<{ slug: string }>();
  return <p data-testid="client-slug">Client slug: {params.slug}</p>;
}
