"use client";
import { useParams } from "next/navigation";
export default function Page() {
  const params = useParams();
  return (
    <div>
      <p id="param-id">{params.id as string}</p>
      <p id="params-json">{JSON.stringify(params)}</p>
    </div>
  );
}
