"use client";

import { useParams } from "next/navigation";

export default function Page() {
  const { id } = useParams<{ id: string }>();
  return <h1 id="page-heading">client-page-dynamic {id}</h1>;
}
