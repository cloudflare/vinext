"use client";
import { useParams } from "next/navigation";
export default function Page() {
  const params = useParams();
  return (
    <div>
      <p id="params-slug">{JSON.stringify(params.slug)}</p>
      <p id="params-json">{JSON.stringify(params)}</p>
    </div>
  );
}
