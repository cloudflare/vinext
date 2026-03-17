"use client";
import { use } from "react";

export default function ClientComponent({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  return <h1>Parameter: {use(searchParams).search}</h1>;
}
